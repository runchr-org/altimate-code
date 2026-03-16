import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"

export async function children(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  return await adapter.getChildrenModels({ table: model })
}

export async function parents(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  return await adapter.getParentModels({ table: model })
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
