/**
 * Unit tests for SQL Server driver logic:
 * - TOP injection (vs LIMIT)
 * - Truncation detection
 * - Azure AD authentication (7 flows)
 * - Schema introspection queries
 * - Connection lifecycle
 * - Result format mapping
 */
import { describe, test, expect, mock, beforeEach } from "bun:test"

// --- Mock mssql ---

let mockQueryCalls: string[] = []
let mockQueryResult: any = { recordset: [] }
let mockConnectCalls: any[] = []
let mockCloseCalls = 0
let mockInputs: Array<{ name: string; value: any }> = []

function resetMocks() {
  mockQueryCalls = []
  mockQueryResult = { recordset: [] }
  mockConnectCalls = []
  mockCloseCalls = 0
  mockInputs = []
}

function createMockRequest() {
  const req: any = {
    input(name: string, value: any) {
      mockInputs.push({ name, value })
      return req
    },
    async query(sql: string) {
      mockQueryCalls.push(sql)
      return mockQueryResult
    },
  }
  return req
}

function createMockPool(config: any) {
  mockConnectCalls.push(config)
  return {
    connect: async () => {},
    request: () => createMockRequest(),
    close: async () => {
      mockCloseCalls++
    },
  }
}

mock.module("mssql", () => ({
  default: {
    connect: async (config: any) => createMockPool(config),
  },
  ConnectionPool: class {
    _pool: any
    constructor(config: any) {
      this._pool = createMockPool(config)
    }
    async connect() { return this._pool.connect() }
    request() { return this._pool.request() }
    async close() { return this._pool.close() }
  },
}))

// Import after mocking
const { connect } = await import("../src/sqlserver")

describe("SQL Server driver unit tests", () => {
  let connector: Awaited<ReturnType<typeof connect>>

  beforeEach(async () => {
    resetMocks()
    connector = await connect({ host: "localhost", port: 1433, database: "testdb", user: "sa", password: "pass" })
    await connector.connect()
  })

  // --- TOP injection ---

  describe("TOP injection", () => {
    test("injects TOP for SELECT without one", async () => {
      mockQueryResult = { recordset: [{ id: 1, name: "a" }] }
      await connector.execute("SELECT * FROM t")
      expect(mockQueryCalls[0]).toContain("TOP 1001")
    })

    test("does NOT double-TOP when TOP already present", async () => {
      mockQueryResult = { recordset: [{ id: 1 }] }
      await connector.execute("SELECT TOP 5 * FROM t")
      expect(mockQueryCalls[0]).toBe("SELECT TOP 5 * FROM t")
    })

    test("does NOT inject TOP when LIMIT present", async () => {
      mockQueryResult = { recordset: [] }
      await connector.execute("SELECT * FROM t LIMIT 10")
      expect(mockQueryCalls[0]).toBe("SELECT * FROM t LIMIT 10")
    })

    test("noLimit bypasses TOP injection", async () => {
      mockQueryResult = { recordset: [] }
      await connector.execute("SELECT * FROM t", undefined, undefined, { noLimit: true })
      expect(mockQueryCalls[0]).toBe("SELECT * FROM t")
    })

    test("uses custom limit value", async () => {
      mockQueryResult = { recordset: [] }
      await connector.execute("SELECT * FROM t", 50)
      expect(mockQueryCalls[0]).toContain("TOP 51")
    })

    test("default limit is 1000", async () => {
      mockQueryResult = { recordset: [] }
      await connector.execute("SELECT * FROM t")
      expect(mockQueryCalls[0]).toContain("TOP 1001")
    })
  })

  // --- Truncation ---

  describe("truncation detection", () => {
    test("detects truncation when rows exceed limit", async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({ id: i }))
      mockQueryResult = { recordset: rows }
      const result = await connector.execute("SELECT * FROM t", 10)
      expect(result.truncated).toBe(true)
      expect(result.rows.length).toBe(10)
    })

    test("no truncation when rows at or below limit", async () => {
      mockQueryResult = { recordset: [{ id: 1 }, { id: 2 }] }
      const result = await connector.execute("SELECT * FROM t", 10)
      expect(result.truncated).toBe(false)
    })

    test("empty result returns correctly", async () => {
      mockQueryResult = { recordset: [], recordset_columns: {} }
      const result = await connector.execute("SELECT * FROM t")
      expect(result.rows).toEqual([])
      expect(result.truncated).toBe(false)
    })
  })

  // --- Azure AD authentication ---

  describe("Azure AD authentication", () => {
    test("standard auth uses user/password directly", async () => {
      resetMocks()
      const c = await connect({ host: "localhost", database: "db", user: "sa", password: "pass" })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.user).toBe("sa")
      expect(cfg.password).toBe("pass")
      expect(cfg.authentication).toBeUndefined()
    })

    test("azure-active-directory-password builds correct auth object", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        user: "user@domain.com",
        password: "secret",
        authentication: "azure-active-directory-password",
        azure_client_id: "client-123",
        azure_tenant_id: "tenant-456",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication).toEqual({
        type: "azure-active-directory-password",
        options: {
          userName: "user@domain.com",
          password: "secret",
          clientId: "client-123",
          tenantId: "tenant-456",
        },
      })
      expect(cfg.user).toBeUndefined()
      expect(cfg.password).toBeUndefined()
    })

    test("azure-active-directory-access-token passes token", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-access-token",
        access_token: "eyJhbGciOi...",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication).toEqual({
        type: "azure-active-directory-access-token",
        options: { token: "eyJhbGciOi..." },
      })
    })

    test("azure-active-directory-service-principal-secret builds SP auth", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-service-principal-secret",
        azure_client_id: "sp-client",
        azure_client_secret: "sp-secret",
        azure_tenant_id: "sp-tenant",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication).toEqual({
        type: "azure-active-directory-service-principal-secret",
        options: {
          clientId: "sp-client",
          clientSecret: "sp-secret",
          tenantId: "sp-tenant",
        },
      })
    })

    test("azure-active-directory-msi-vm builds MSI auth with optional clientId", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-msi-vm",
        azure_client_id: "msi-client",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication).toEqual({
        type: "azure-active-directory-msi-vm",
        options: { clientId: "msi-client" },
      })
    })

    test("azure-active-directory-msi-app-service works without clientId", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-msi-app-service",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication).toEqual({
        type: "azure-active-directory-msi-app-service",
        options: {},
      })
    })

    test("azure-active-directory-default passes type to tedious (no credential object)", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-default",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication.type).toBe("azure-active-directory-default")
      expect(cfg.authentication.options.credential).toBeUndefined()
    })

    test("azure-active-directory-default with client_id passes clientId option", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-default",
        azure_client_id: "mi-client-id",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication.type).toBe("azure-active-directory-default")
      expect(cfg.authentication.options.clientId).toBe("mi-client-id")
    })

    test("encryption forced for all Azure AD connections", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-password",
        user: "u",
        password: "p",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.options.encrypt).toBe(true)
    })

    test("standard auth does not force encryption", async () => {
      resetMocks()
      const c = await connect({ host: "localhost", database: "db", user: "sa", password: "pass" })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.options.encrypt).toBe(false)
    })

    test("'CLI' shorthand maps to azure-active-directory-default", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.datawarehouse.fabric.microsoft.com",
        database: "migration",
        authentication: "CLI",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication.type).toBe("azure-active-directory-default")
      expect(cfg.options.encrypt).toBe(true)
    })

    test("'service-principal' shorthand maps correctly", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "service-principal",
        azure_client_id: "cid",
        azure_client_secret: "csec",
        azure_tenant_id: "tid",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication.type).toBe("azure-active-directory-service-principal-secret")
      expect(cfg.authentication.options.clientId).toBe("cid")
    })

    test("'msi' shorthand maps to azure-active-directory-msi-vm", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "msi",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication.type).toBe("azure-active-directory-msi-vm")
    })
  })

  // --- Schema introspection ---

  describe("schema introspection", () => {
    test("listSchemas queries sys.schemas", async () => {
      mockQueryResult = { recordset: [{ name: "dbo" }, { name: "sales" }] }
      const schemas = await connector.listSchemas()
      expect(mockQueryCalls[0]).toContain("sys.schemas")
      expect(schemas).toEqual(["dbo", "sales"])
    })

    test("listTables queries sys.tables and sys.views", async () => {
      mockQueryResult = {
        recordset: [
          { name: "orders", type: "U " },
          { name: "order_summary", type: "V" },
        ],
      }
      const tables = await connector.listTables("dbo")
      expect(mockQueryCalls[0]).toContain("UNION ALL")
      expect(mockQueryCalls[0]).toContain("sys.tables")
      expect(mockQueryCalls[0]).toContain("sys.views")
      expect(tables).toEqual([
        { name: "orders", type: "table" },
        { name: "order_summary", type: "view" },
      ])
    })

    test("describeTable queries sys.columns", async () => {
      mockQueryResult = {
        recordset: [
          { column_name: "id", data_type: "int", is_nullable: 0 },
          { column_name: "name", data_type: "nvarchar", is_nullable: 1 },
        ],
      }
      const cols = await connector.describeTable("dbo", "users")
      expect(mockQueryCalls[0]).toContain("sys.columns")
      expect(cols).toEqual([
        { name: "id", data_type: "int", nullable: false },
        { name: "name", data_type: "nvarchar", nullable: true },
      ])
    })
  })

  // --- Connection lifecycle ---

  describe("connection lifecycle", () => {
    test("close is idempotent", async () => {
      await connector.close()
      await connector.close()
      expect(mockCloseCalls).toBe(1)
    })
  })

  // --- Result format ---

  describe("result format", () => {
    test("maps recordset to column-ordered arrays", async () => {
      mockQueryResult = {
        recordset: [
          { id: 1, name: "alice", age: 30 },
          { id: 2, name: "bob", age: 25 },
        ],
      }
      const result = await connector.execute("SELECT id, name, age FROM t")
      expect(result.columns).toEqual(["id", "name", "age"])
      expect(result.rows).toEqual([
        [1, "alice", 30],
        [2, "bob", 25],
      ])
    })

    test("preserves underscore-prefixed columns", async () => {
      mockQueryResult = {
        recordset: [{ id: 1, _p: "Delivered", name: "x" }],
      }
      const result = await connector.execute("SELECT * FROM t")
      expect(result.columns).toEqual(["id", "_p", "name"])
    })
  })

  // --- Unnamed column flattening ---

  describe("unnamed column flattening", () => {
    test("flattens unnamed columns merged under empty-string key", async () => {
      // mssql merges SELECT COUNT(*), SUM(amount) into row[""] = [42, 1000]
      mockQueryResult = {
        recordset: [{ "": [42, 1000] }],
      }
      const result = await connector.execute("SELECT COUNT(*), SUM(amount) FROM t")
      expect(result.rows).toEqual([[42, 1000]])
      expect(result.columns).toEqual(["col_0", "col_1"])
    })

    test("preserves legitimate array values from named columns", async () => {
      // A named column containing an array (e.g. from JSON aggregation)
      // should NOT be spread — only the empty-string key gets flattened
      mockQueryResult = {
        recordset: [{ id: 1, tags: ["a", "b", "c"] }],
      }
      const result = await connector.execute("SELECT * FROM t")
      expect(result.columns).toEqual(["id", "tags"])
      expect(result.rows).toEqual([[1, ["a", "b", "c"]]])
    })

    test("handles mix of named and unnamed columns", async () => {
      mockQueryResult = {
        recordset: [{ name: "alice", "": [42] }],
      }
      const result = await connector.execute("SELECT * FROM t")
      expect(result.rows).toEqual([["alice", 42]])
    })
  })
})
