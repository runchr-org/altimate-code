import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"
// altimate_change start — for auto-load skill matching against project files
import { Glob } from "../util/glob"
import { Log } from "../util/log"
// altimate_change end

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"
import { Skill } from "@/skill"
// altimate_change start - import for env-based skill selection
import { Fingerprint } from "../altimate/fingerprint"
import { Config } from "../config/config"
import { selectSkillsWithLLM } from "../altimate/skill-selector"
// altimate_change end

export namespace SystemPrompt {
  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Workspace root folder: ${Instance.worktree}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }

  export async function skills(agent: Agent.Info) {
    if (PermissionNext.disabled(["skill"], agent.permission).has("skill")) return

    const list = await Skill.available(agent)

    // altimate_change start - apply env-based skill selection
    const cfg = await Config.get()
    let filtered: Skill.Info[]
    if (cfg.experimental?.env_fingerprint_skill_selection === true) {
      filtered = await selectSkillsWithLLM(list, Fingerprint.get())
    } else {
      filtered = list
    }
    // Sort by name for stable, deterministic output across calls.
    filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name))
    // altimate_change end

    // altimate_change start — auto-load skill bodies for skills marked
    // `alwaysApply: true` (unconditional) or whose `applyPaths` glob matches
    // at least one file in the worktree. This mirrors Cursor's "Always Apply"
    // and "Auto Attached" rule modes — the skill body lands in the system
    // prompt deterministically instead of waiting for the agent to invoke the
    // Skill tool (observed in benchmark traces to fire <1% of tool calls).
    //
    // Placement: auto-loaded bodies go FIRST, before the lazy-loaded
    // <available_skills> XML block. Benchmark trace analysis showed that
    // when the auto-load block was placed at the END of the skills section,
    // the model treated it as background reference rather than binding
    // directive, and frequently failed to apply its guidance even when
    // explicitly relevant. Putting it first frames it as "rules of the road"
    // for the session before listing optional on-demand skills.
    const autoLoaded = await collectAutoLoadedSkills(filtered)
    const parts: string[] = []
    if (autoLoaded.length > 0) {
      parts.push(
        "The following skill(s) are auto-loaded because they apply to this project.",
        "Treat their content as binding guidance for any related work — you do not need to",
        "invoke the Skill tool again to access them.",
      )
      for (const skill of autoLoaded) {
        parts.push("")
        parts.push(`<auto_loaded_skill name="${skill.name}">`)
        parts.push(skill.content.trim())
        parts.push(`</auto_loaded_skill>`)
      }
      parts.push("")
    }
    parts.push(
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      // the agents seem to ingest the information about skills a bit better if we present a more verbose
      // version of them here and a less verbose version in tool description, rather than vice versa.
      Skill.fmt(filtered, { verbose: true }),
    )
    // altimate_change end

    return parts.join("\n")
  }

  // altimate_change start — helpers for auto-load skill selection
  const autoLoadLog = Log.create({ service: "system-prompt-autoload" })

  async function collectAutoLoadedSkills(list: Skill.Info[]): Promise<Skill.Info[]> {
    const out: Skill.Info[] = []
    for (const skill of list) {
      if (skill.alwaysApply === true) {
        out.push(skill)
        continue
      }
      const globs = normalizeApplyPaths(skill.applyPaths)
      if (globs.length === 0) continue
      try {
        const matched = await anyMatchInWorktree(globs)
        if (matched) {
          out.push(skill)
          autoLoadLog.info("skill auto-loaded by applyPaths", {
            skill: skill.name,
            globs,
          })
        }
      } catch (err) {
        autoLoadLog.warn("applyPaths glob scan failed", { skill: skill.name, err })
      }
    }
    return out
  }

  function normalizeApplyPaths(v: Skill.Info["applyPaths"]): string[] {
    if (!v) return []
    if (typeof v === "string") return [v]
    return v.filter((s) => typeof s === "string" && s.length > 0)
  }

  async function anyMatchInWorktree(globs: string[]): Promise<boolean> {
    // Search from worktree root so a skill that wants `dbt_project.yml`
    // catches the file no matter how deep the user's cwd is.
    const root = Instance.worktree
    for (const g of globs) {
      const matches = await Glob.scan(g, {
        cwd: root,
        absolute: true,
        include: "file",
        dot: false,
        symlink: false,
      }).catch(() => [] as string[])
      if (matches.length > 0) return true
    }
    return false
  }
  // altimate_change end
}
