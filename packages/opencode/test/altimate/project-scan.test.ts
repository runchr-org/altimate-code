import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import {
  detectDbtProject,
  detectEnvVars,
  parseToolVersion,
  detectConfigFiles,
} from "../../src/altimate/tools/project-scan"

// ---------------------------------------------------------------------------
// 1. parseToolVersion — pure function, no I/O
// ---------------------------------------------------------------------------
describe("parseToolVersion", () => {
  test("extracts version from 'dbt version 1.7.4'", () => {
    expect(parseToolVersion("dbt version 1.7.4")).toBe("1.7.4")
  })

  test("extracts version from multi-line output (first line only)", () => {
    const output = "sqlfluff 2.3.5\nPython 3.11.4\nSome extra info"
    expect(parseToolVersion(output)).toBe("2.3.5")
  })

  test("extracts two-part version like '14.2'", () => {
    expect(parseToolVersion("psql (PostgreSQL) 14.2")).toBe("14.2")
  })

  test("handles 'v' prefix (regex matches digits, not the v)", () => {
    expect(parseToolVersion("v1.2.3")).toBe("1.2.3")
  })

  test("returns undefined when no version found", () => {
    expect(parseToolVersion("no version here")).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(parseToolVersion("")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. detectDbtProject — filesystem traversal + regex parsing
// ---------------------------------------------------------------------------
describe("detectDbtProject", () => {
  test("finds dbt_project.yml in current directory with name and profile", async () => {
    await using tmp = await tmpdir()
    const projectYml = [
      "name: 'my_analytics'",
      "version: '1.0.0'",
      "profile: 'snowflake_prod'",
      "model-paths: ['models']",
    ].join("\n")
    await fs.writeFile(path.join(tmp.path, "dbt_project.yml"), projectYml)

    const result = await detectDbtProject(tmp.path)
    expect(result.found).toBe(true)
    expect(result.name).toBe("my_analytics")
    expect(result.profile).toBe("snowflake_prod")
    expect(result.path).toBe(tmp.path)
  })

  test("parses unquoted name and profile", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "dbt_project.yml"),
      "name: warehouse_project\nprofile: default\n",
    )

    const result = await detectDbtProject(tmp.path)
    expect(result.found).toBe(true)
    expect(result.name).toBe("warehouse_project")
    expect(result.profile).toBe("default")
  })

  test("walks up parent directories to find project", async () => {
    await using tmp = await tmpdir()
    // Create dbt_project.yml at root level
    await fs.writeFile(
      path.join(tmp.path, "dbt_project.yml"),
      "name: root_project\nprofile: dev\n",
    )
    // Start search from a nested directory
    const nested = path.join(tmp.path, "models", "staging")
    await fs.mkdir(nested, { recursive: true })

    const result = await detectDbtProject(nested)
    expect(result.found).toBe(true)
    expect(result.name).toBe("root_project")
    expect(result.path).toBe(tmp.path)
  })

  test("respects 5-iteration limit (4 hops up from start)", async () => {
    await using tmp = await tmpdir()
    // Create a deeply nested structure: 5 levels deep
    // The loop runs i=0..4 (5 iterations), checking startDir then 4 parents
    const deep = path.join(tmp.path, "a", "b", "c", "d", "e")
    await fs.mkdir(deep, { recursive: true })

    // Place dbt_project.yml at tmp.path (4 hops up from "e")
    // a/b/c/d/e → a/b/c/d → a/b/c → a/b → a → tmp.path = 5 hops
    // But the loop only does 5 iterations: e, d, c, b, a — stops before tmp.path
    await fs.writeFile(
      path.join(tmp.path, "dbt_project.yml"),
      "name: too_far\n",
    )

    const result = await detectDbtProject(deep)
    // 5 iterations check: e(0), d(1), c(2), b(3), a(4) — tmp.path is the 6th, not reached
    expect(result.found).toBe(false)
  })

  test("finds project at exactly 4 hops up (iteration limit boundary)", async () => {
    await using tmp = await tmpdir()
    // 4 levels deep: a/b/c/d
    const deep = path.join(tmp.path, "a", "b", "c", "d")
    await fs.mkdir(deep, { recursive: true })

    // Place dbt_project.yml at tmp.path (4 hops up from "d")
    // d → c → b → a → tmp.path = 4 hops = 5 iterations (i=0..4)
    await fs.writeFile(
      path.join(tmp.path, "dbt_project.yml"),
      "name: boundary_project\n",
    )

    const result = await detectDbtProject(deep)
    expect(result.found).toBe(true)
    expect(result.name).toBe("boundary_project")
  })

  test("returns { found: false } when no dbt_project.yml exists", async () => {
    await using tmp = await tmpdir()
    const result = await detectDbtProject(tmp.path)
    expect(result.found).toBe(false)
    expect(result.path).toBeUndefined()
  })

  test("detects manifest.json in target/ subdirectory", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "dbt_project.yml"),
      "name: proj\n",
    )
    const targetDir = path.join(tmp.path, "target")
    await fs.mkdir(targetDir)
    await fs.writeFile(path.join(targetDir, "manifest.json"), "{}")

    const result = await detectDbtProject(tmp.path)
    expect(result.found).toBe(true)
    expect(result.manifestPath).toBe(path.join(targetDir, "manifest.json"))
  })

  test("manifestPath is undefined when target/manifest.json is missing", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "dbt_project.yml"),
      "name: proj\n",
    )

    const result = await detectDbtProject(tmp.path)
    expect(result.found).toBe(true)
    expect(result.manifestPath).toBeUndefined()
  })

  test("detects packages.yml", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "dbt_project.yml"),
      "name: proj\n",
    )
    await fs.writeFile(path.join(tmp.path, "packages.yml"), "packages: []")

    const result = await detectDbtProject(tmp.path)
    expect(result.hasPackages).toBe(true)
  })

  test("detects dependencies.yml as alternative to packages.yml", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "dbt_project.yml"),
      "name: proj\n",
    )
    await fs.writeFile(
      path.join(tmp.path, "dependencies.yml"),
      "packages: []",
    )

    const result = await detectDbtProject(tmp.path)
    expect(result.hasPackages).toBe(true)
  })

  test("hasPackages is false when neither file exists", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(
      path.join(tmp.path, "dbt_project.yml"),
      "name: proj\n",
    )

    const result = await detectDbtProject(tmp.path)
    expect(result.hasPackages).toBe(false)
  })

  test("regex anchor: indented 'name:' is NOT matched (^ requires start of line)", async () => {
    await using tmp = await tmpdir()
    // The regex uses ^name: with multiline flag, so indented lines won't match
    await fs.writeFile(
      path.join(tmp.path, "dbt_project.yml"),
      "  name: indented_project\n  profile: indented_profile\n",
    )

    const result = await detectDbtProject(tmp.path)
    expect(result.found).toBe(true)
    expect(result.name).toBeUndefined() // ^ anchor prevents matching indented lines
    expect(result.profile).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. detectEnvVars — environment variable detection with masking
// ---------------------------------------------------------------------------
describe("detectEnvVars", () => {
  // Save and restore env vars to prevent test pollution
  const envBackup: Record<string, string | undefined> = {}
  const envKeys = [
    "SNOWFLAKE_ACCOUNT",
    "SNOWFLAKE_USER",
    "SNOWFLAKE_PASSWORD",
    "SNOWFLAKE_WAREHOUSE",
    "SNOWFLAKE_DATABASE",
    "PGHOST",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "DATABASE_URL",
    "DATABRICKS_HOST",
    "DATABRICKS_HTTP_PATH",
    "DATABRICKS_TOKEN",
    "BIGQUERY_PROJECT",
    "GCP_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLICKHOUSE_HOST",
    "CLICKHOUSE_DB",
    "CLICKHOUSE_USER",
    "CLICKHOUSE_PASSWORD",
    "CLICKHOUSE_URL",
  ]

  beforeEach(() => {
    for (const key of envKeys) {
      envBackup[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (envBackup[key] !== undefined) {
        process.env[key] = envBackup[key]
      } else {
        delete process.env[key]
      }
    }
  })

  test("returns empty array when no warehouse env vars are set", async () => {
    const result = await detectEnvVars()
    expect(result).toEqual([])
  })

  test("detects snowflake from SNOWFLAKE_ACCOUNT", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "myaccount.us-east-1"
    process.env.SNOWFLAKE_USER = "analyst"
    process.env.SNOWFLAKE_WAREHOUSE = "COMPUTE_WH"

    const result = await detectEnvVars()
    const sf = result.find((c) => c.type === "snowflake")
    expect(sf).toBeDefined()
    expect(sf!.name).toBe("env_snowflake")
    expect(sf!.source).toBe("env-var")
    expect(sf!.signal).toBe("SNOWFLAKE_ACCOUNT")
    expect(sf!.config.account).toBe("myaccount.us-east-1")
    expect(sf!.config.user).toBe("analyst")
    expect(sf!.config.warehouse).toBe("COMPUTE_WH")
  })

  test("masks sensitive fields with '***'", async () => {
    process.env.SNOWFLAKE_ACCOUNT = "myaccount"
    process.env.SNOWFLAKE_PASSWORD = "super_secret_password"

    const result = await detectEnvVars()
    const sf = result.find((c) => c.type === "snowflake")
    expect(sf).toBeDefined()
    expect(sf!.config.password).toBe("***")
  })

  test("masks databricks access_token", async () => {
    process.env.DATABRICKS_HOST = "dbc-abc123.cloud.databricks.com"
    process.env.DATABRICKS_HTTP_PATH = "/sql/1.0/warehouses/abc"
    process.env.DATABRICKS_TOKEN = "dapi12345"

    const result = await detectEnvVars()
    const db = result.find((c) => c.type === "databricks")
    expect(db).toBeDefined()
    expect(db!.config.access_token).toBe("***")
    expect(db!.config.server_hostname).toBe("dbc-abc123.cloud.databricks.com")
  })

  test("array configMap: first matching env var wins", async () => {
    // BigQuery has project: ["BIGQUERY_PROJECT", "GCP_PROJECT"]
    process.env.BIGQUERY_PROJECT = "my-bq-project"
    process.env.GCP_PROJECT = "my-gcp-project"

    const result = await detectEnvVars()
    const bq = result.find((c) => c.type === "bigquery")
    expect(bq).toBeDefined()
    // BIGQUERY_PROJECT is first in the array, should win
    expect(bq!.config.project).toBe("my-bq-project")
  })

  test("DATABASE_URL with postgresql:// scheme creates postgres connection", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/mydb"

    const result = await detectEnvVars()
    const pg = result.find((c) => c.type === "postgres")
    expect(pg).toBeDefined()
    expect(pg!.signal).toBe("DATABASE_URL")
    // connection_string is sensitive, must be masked
    expect(pg!.config.connection_string).toBe("***")
  })

  test("DATABASE_URL with mysql:// scheme creates mysql connection", async () => {
    process.env.DATABASE_URL = "mysql://user:pass@localhost:3306/mydb"

    const result = await detectEnvVars()
    const mysql = result.find((c) => c.type === "mysql")
    expect(mysql).toBeDefined()
    expect(mysql!.signal).toBe("DATABASE_URL")
  })

  test("DATABASE_URL with clickhouse+http:// scheme creates clickhouse connection", async () => {
    process.env.DATABASE_URL = "clickhouse+http://user:pass@localhost:8123/default"

    const result = await detectEnvVars()
    const ch = result.find((c) => c.type === "clickhouse")
    expect(ch).toBeDefined()
    expect(ch!.signal).toBe("DATABASE_URL")
  })

  test("DATABASE_URL does not duplicate when type already detected via dedicated env vars", async () => {
    // Set both PGHOST (detects postgres) and DATABASE_URL with postgres scheme
    process.env.PGHOST = "localhost"
    process.env.PGDATABASE = "mydb"
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/mydb"

    const result = await detectEnvVars()
    const pgEntries = result.filter((c) => c.type === "postgres")
    // Should only have one postgres entry (from PGHOST), not a duplicate from DATABASE_URL
    expect(pgEntries.length).toBe(1)
    expect(pgEntries[0].signal).toBe("PGHOST")
  })
})
