/**
 * SQL Server driver using the `mssql` (tedious) package.
 */

import type { ConnectionConfig, Connector, ConnectorResult, ExecuteOptions, SchemaColumn } from "./types"

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let mssql: any
  let MssqlConnectionPool: any
  try {
    // @ts-expect-error — mssql has no type declarations; installed as optional peerDependency
    const mod = await import("mssql")
    mssql = mod.default || mod
    // ConnectionPool is a named export, not on .default
    MssqlConnectionPool = mod.ConnectionPool ?? mssql.ConnectionPool
  } catch {
    throw new Error(
      "SQL Server driver not installed. Run: npm install mssql",
    )
  }

  let pool: any

  return {
    async connect() {
      const mssqlConfig: Record<string, unknown> = {
        server: config.host ?? "127.0.0.1",
        port: config.port ?? 1433,
        database: config.database,
        options: {
          encrypt: config.encrypt ?? false,
          trustServerCertificate: config.trust_server_certificate ?? true,
          connectTimeout: 10000,
          requestTimeout: 30000,
        },
        pool: {
          max: 5,
          min: 0,
          idleTimeoutMillis: 30000,
        },
      }

      // Normalize shorthand auth values to tedious-compatible types
      const AUTH_SHORTHANDS: Record<string, string> = {
        cli: "azure-active-directory-default",
        default: "azure-active-directory-default",
        password: "azure-active-directory-password",
        "service-principal": "azure-active-directory-service-principal-secret",
        serviceprincipal: "azure-active-directory-service-principal-secret",
        "managed-identity": "azure-active-directory-msi-vm",
        msi: "azure-active-directory-msi-vm",
      }
      const rawAuth = config.authentication as string | undefined
      const authType = rawAuth ? (AUTH_SHORTHANDS[rawAuth.toLowerCase()] ?? rawAuth) : undefined

      if (authType?.startsWith("azure-active-directory")) {
        ;(mssqlConfig.options as any).encrypt = true

        if (authType === "azure-active-directory-default") {
          // Acquire a token ourselves and pass it as a raw access token string.
          // We avoid using @azure/identity's DefaultAzureCredential because:
          //  1. Bun can resolve @azure/identity to the browser bundle (inside
          //     tedious or even our own import), where DefaultAzureCredential
          //     is a non-functional stub that throws.
          //  2. Passing a credential object via type:"token-credential" hits a
          //     CJS/ESM isTokenCredential boundary mismatch in Bun.
          //
          // Strategy: try @azure/identity first (works when module resolution
          // is correct), fall back to shelling out to `az account get-access-token`
          // (works everywhere Azure CLI is installed).
          let token: string | undefined

          // Attempt 1: @azure/identity (fast, no subprocess)
          try {
            const azureIdentity = await import("@azure/identity")
            const credential = new azureIdentity.DefaultAzureCredential(
              config.azure_client_id
                ? { managedIdentityClientId: config.azure_client_id as string }
                : undefined,
            )
            const tokenResponse = await credential.getToken("https://database.windows.net/.default")
            token = tokenResponse?.token
          } catch {
            // @azure/identity unavailable or browser bundle — fall through
          }

          // Attempt 2: Azure CLI subprocess (universal fallback)
          if (!token) {
            try {
              const { execSync } = await import("node:child_process")
              const json = execSync(
                "az account get-access-token --resource https://database.windows.net/ --query accessToken -o tsv",
                { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] },
              ).trim()
              if (json) token = json
            } catch {
              // az CLI not installed or not logged in
            }
          }

          if (!token) {
            throw new Error(
              "Azure AD default auth failed. Either install @azure/identity (npm install @azure/identity) " +
              "or log in with Azure CLI (az login).",
            )
          }

          mssqlConfig.authentication = {
            type: "azure-active-directory-access-token",
            options: { token },
          }
        } else if (authType === "azure-active-directory-password") {
          mssqlConfig.authentication = {
            type: "azure-active-directory-password",
            options: {
              userName: config.user,
              password: config.password,
              clientId: config.azure_client_id,
              tenantId: config.azure_tenant_id,
            },
          }
        } else if (authType === "azure-active-directory-access-token") {
          mssqlConfig.authentication = {
            type: "azure-active-directory-access-token",
            options: { token: config.token ?? config.access_token },
          }
        } else if (
          authType === "azure-active-directory-msi-vm" ||
          authType === "azure-active-directory-msi-app-service"
        ) {
          mssqlConfig.authentication = {
            type: authType,
            options: {
              ...(config.azure_client_id ? { clientId: config.azure_client_id } : {}),
            },
          }
        } else if (authType === "azure-active-directory-service-principal-secret") {
          mssqlConfig.authentication = {
            type: "azure-active-directory-service-principal-secret",
            options: {
              clientId: config.azure_client_id,
              clientSecret: config.azure_client_secret,
              tenantId: config.azure_tenant_id,
            },
          }
        }
      } else {
        // Standard SQL Server user/password
        mssqlConfig.user = config.user
        mssqlConfig.password = config.password
      }

      // Use an explicit ConnectionPool (not the global mssql.connect()) so
      // multiple simultaneous connections to different servers are isolated.
      if (MssqlConnectionPool) {
        pool = new MssqlConnectionPool(mssqlConfig)
        await pool.connect()
      } else {
        pool = await mssql.connect(mssqlConfig)
      }
    },

    async execute(sql: string, limit?: number, _binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult> {
      const effectiveLimit = options?.noLimit ? 0 : (limit ?? 1000)

      let query = sql
      const isSelectLike = /^\s*SELECT\b/i.test(sql)
      // SQL Server uses TOP, not LIMIT
      if (
        isSelectLike &&
        effectiveLimit &&
        !/\bTOP\b/i.test(sql) &&
        !/\bLIMIT\b/i.test(sql)
      ) {
        // Insert TOP after SELECT
        query = sql.replace(
          /^(\s*SELECT\s)/i,
          `$1TOP ${effectiveLimit + 1} `,
        )
      }

      const result = await pool.request().query(query)
      const recordset = result.recordset ?? []
      const truncated = effectiveLimit > 0 && recordset.length > effectiveLimit
      const limitedRecordset = truncated ? recordset.slice(0, effectiveLimit) : recordset

      // mssql merges unnamed columns (e.g. SELECT COUNT(*), SUM(...)) into a
      // single array under the empty-string key: row[""] = [val1, val2, ...].
      // Flatten only the empty-string key to restore positional column values;
      // legitimate array values from other keys are preserved as-is.
      const flattenRow = (row: any): any[] => {
        const vals: any[] = []
        for (const [k, v] of Object.entries(row)) {
          if (k === "" && Array.isArray(v)) vals.push(...v)
          else vals.push(v)
        }
        return vals
      }

      const rows = limitedRecordset.map(flattenRow)
      const sampleFlat = rows.length > 0 ? rows[0] : []
      const namedKeys = recordset.length > 0 ? Object.keys(recordset[0]) : []
      const columns =
        namedKeys.length === sampleFlat.length
          ? namedKeys
          : sampleFlat.length > 0
            ? sampleFlat.map((_: any, i: number) => `col_${i}`)
            : (result.recordset?.columns
                ? Object.keys(result.recordset.columns)
                : [])

      return {
        columns,
        rows,
        row_count: rows.length,
        truncated,
      }
    },

    async listSchemas(): Promise<string[]> {
      const result = await pool
        .request()
        .query(
          "SELECT name FROM sys.schemas WHERE name NOT IN ('guest','INFORMATION_SCHEMA','sys') ORDER BY name",
        )
      return result.recordset.map((r: any) => r.name as string)
    },

    async listTables(
      schema: string,
    ): Promise<Array<{ name: string; type: string }>> {
      const result = await pool
        .request()
        .input("schema", schema)
        .query(
          `SELECT t.name, t.type
           FROM sys.tables t
           INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
           WHERE s.name = @schema
           UNION ALL
           SELECT v.name, 'V' as type
           FROM sys.views v
           INNER JOIN sys.schemas s ON v.schema_id = s.schema_id
           WHERE s.name = @schema
           ORDER BY name`,
        )
      return result.recordset.map((r: any) => ({
        name: r.name as string,
        type: r.type?.trim() === "V" ? "view" : "table",
      }))
    },

    async describeTable(
      schema: string,
      table: string,
    ): Promise<SchemaColumn[]> {
      const result = await pool
        .request()
        .input("schema", schema)
        .input("table", table)
        .query(
          `SELECT c.name AS column_name,
                  tp.name AS data_type,
                  c.is_nullable
           FROM sys.columns c
           INNER JOIN sys.types tp ON c.user_type_id = tp.user_type_id
           INNER JOIN sys.objects o ON c.object_id = o.object_id
           INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
           WHERE s.name = @schema AND o.name = @table
             AND o.type IN ('U', 'V')
           ORDER BY c.column_id`,
        )
      return result.recordset.map((r: any) => ({
        name: r.column_name as string,
        data_type: r.data_type as string,
        nullable: r.is_nullable === 1,
      }))
    },

    async close() {
      if (pool) {
        await pool.close()
        pool = null
      }
    },
  }
}
