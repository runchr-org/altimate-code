import { cpSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"

const dist = join(import.meta.dir, "..", "dist")

// 1. Copy altimate_python_packages
const resolved = require.resolve("@altimateai/dbt-integration")
const source = join(dirname(resolved), "altimate_python_packages")
cpSync(source, join(dist, "altimate_python_packages"), { recursive: true })
console.log(`Copied altimate_python_packages → dist/`)

// 2. Copy node_python_bridge.py into dist so it lives next to index.js
// node_python_bridge.py is shipped in dbt-integration's dist
const bridgePy = join(dirname(resolved), "node_python_bridge.py")
cpSync(bridgePy, join(dist, "node_python_bridge.py"))
console.log(`Copied node_python_bridge.py → dist/`)

// 3. Fix the hardcoded __dirname that bun bakes at compile time.
//    Replace it with a runtime resolution so the bridge script is found
//    relative to the built index.js, not the CI runner's node_modules.
const indexPath = join(dist, "index.js")
let code = readFileSync(indexPath, "utf8")
const pattern = /var __dirname\s*=\s*"[^"]*python-bridge[^"]*"/
if (pattern.test(code)) {
  code = code.replace(pattern, `var __dirname = import.meta.dirname`)
  writeFileSync(indexPath, code)
  console.log(`Patched __dirname in dist/index.js`)
} else {
  console.error(`ERROR: could not find python-bridge __dirname to patch — the bundle format may have changed`)
  process.exit(1)
}
