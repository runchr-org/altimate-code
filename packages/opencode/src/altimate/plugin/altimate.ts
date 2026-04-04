import type { Hooks, PluginInput } from "@opencode-ai/plugin"

export async function AltimateAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "altimate-backend",
      methods: [
        {
          type: "api",
          label: "Connect to Altimate",
        },
      ],
    },
  }
}
