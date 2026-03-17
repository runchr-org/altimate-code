import { createSignal, Show, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "../context/theme"
import { AltimateApi } from "@/altimate/api/client"
import { Filesystem } from "@/util/filesystem"

export function DialogAltimateLogin() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const [error, setError] = createSignal("")
  const [validating, setValidating] = createSignal(false)
  const [store, setStore] = createStore({
    active: "instance" as "instance" | "key" | "url",
  })

  let instanceRef: TextareaRenderable
  let keyRef: TextareaRenderable
  let urlRef: TextareaRenderable

  const fields = ["instance", "key", "url"] as const

  function focusActive() {
    setTimeout(() => {
      const ref = { instance: instanceRef, key: keyRef, url: urlRef }[store.active]
      if (ref && !ref.isDestroyed) ref.focus()
    }, 1)
  }

  useKeyboard((evt) => {
    if (evt.name === "tab") {
      const idx = fields.indexOf(store.active)
      const next = fields[(idx + 1) % fields.length]
      setStore("active", next)
      focusActive()
      evt.preventDefault()
    }
    if (evt.name === "return") {
      if (validating()) return
      void submit().catch((e) => setError(`Unexpected error: ${e?.message ?? e}`))
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    focusActive()
  })

  async function submit() {
    const instance = instanceRef.plainText.trim()
    const key = keyRef.plainText.trim()
    const url = urlRef.plainText.trim().replace(/\/+$/, "")

    if (!instance) {
      setError("Instance name is required")
      setStore("active", "instance")
      focusActive()
      return
    }
    if (!key) {
      setError("API key is required")
      setStore("active", "key")
      focusActive()
      return
    }
    if (!url) {
      setError("URL is required")
      setStore("active", "url")
      focusActive()
      return
    }

    setError("")
    setValidating(true)
    try {
      const res = await fetch(`${url}/auth_health`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          "x-tenant": instance,
        },
      })
      if (!res.ok) {
        setError("Invalid credentials — check your instance name, API key, and URL")
        setValidating(false)
        return
      }
      const data = await res.json()
      if (data.status !== "auth_valid") {
        setError("Unexpected response from server")
        setValidating(false)
        return
      }
    } catch {
      setError(`Connection failed — could not reach ${url}`)
      setValidating(false)
      return
    }

    try {
      const creds = {
        altimateUrl: url,
        altimateInstanceName: instance,
        altimateApiKey: key,
      }
      await Filesystem.writeJson(AltimateApi.credentialsPath(), creds, 0o600)
      await sdk.client.instance.dispose()
      await sync.bootstrap()
      dialog.clear()
    } finally {
      setValidating(false)
    }
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Connect to Altimate
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <text fg={theme.textMuted}>Find these in Settings &gt; API Keys in your Altimate dashboard</text>

      <box>
        <text fg={store.active === "instance" ? theme.text : theme.textMuted}>Instance Name:</text>
        <text fg={theme.textMuted}>  From your URL: https://&lt;instance&gt;.app.myaltimate.com</text>
        <textarea
          height={3}
          ref={(val: TextareaRenderable) => (instanceRef = val)}
          placeholder="your-instance"
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
          onMouseUp={() => {
            setStore("active", "instance")
            focusActive()
          }}
        />
      </box>

      <box>
        <text fg={store.active === "key" ? theme.text : theme.textMuted}>API Key:</text>
        <text fg={theme.textMuted}>  Settings &gt; API Keys &gt; Copy</text>
        <textarea
          height={3}
          ref={(val: TextareaRenderable) => (keyRef = val)}
          placeholder="your-api-key"
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
          onMouseUp={() => {
            setStore("active", "key")
            focusActive()
          }}
        />
      </box>

      <box>
        <text fg={store.active === "url" ? theme.text : theme.textMuted}>URL:</text>
        <textarea
          height={3}
          ref={(val: TextareaRenderable) => (urlRef = val)}
          initialValue="https://api.myaltimate.com"
          placeholder="https://api.myaltimate.com"
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
          onMouseUp={() => {
            setStore("active", "url")
            focusActive()
          }}
        />
      </box>

      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
      <Show when={validating()}>
        <text fg={theme.textMuted}>Validating credentials...</text>
      </Show>

      <text fg={theme.textMuted} paddingBottom={1}>
        <span style={{ fg: theme.text }}>tab</span> next field{"  "}
        <span style={{ fg: theme.text }}>enter</span> submit
      </text>
    </box>
  )
}
