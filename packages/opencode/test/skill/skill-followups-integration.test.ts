import { test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { SkillFollowups } from "../../src/skill/followups"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"

test("skill with followups: format appears before skill_content", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "dbt-develop")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: dbt-develop
description: Create dbt models.
---

# dbt Model Development

Instructions here.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skill = await Skill.get("dbt-develop")
      expect(skill).toBeDefined()

      // Verify followups exist and are well-formed
      const followups = SkillFollowups.format("dbt-develop")
      expect(followups).toContain("## What's Next?")
      expect(followups).toContain("dbt-test")
      expect(followups).toContain("dbt-docs")

      // Simulate the output assembly order from SkillTool to verify
      // followups come BEFORE <skill_content> (survives truncation)
      const output = [
        ...(followups ? [followups, ""] : []),
        `<skill_content name="${skill!.name}">`,
        skill!.content.trim(),
        "</skill_content>",
      ].join("\n")

      const followupsIdx = output.indexOf("## What's Next?")
      const skillContentIdx = output.indexOf("<skill_content")
      expect(followupsIdx).toBeGreaterThan(-1)
      expect(skillContentIdx).toBeGreaterThan(-1)
      expect(followupsIdx).toBeLessThan(skillContentIdx)
    },
  })
})

test("skill without followups: no extra content before skill_content", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "custom-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: custom-skill
description: A custom skill.
---

# Custom Skill

Do custom things.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skill = await Skill.get("custom-skill")
      expect(skill).toBeDefined()

      // No followups for unknown skills
      const followups = SkillFollowups.format("custom-skill")
      expect(followups).toBe("")

      // Output should start directly with skill_content
      const output = [
        ...(followups ? [followups, ""] : []),
        `<skill_content name="${skill!.name}">`,
        skill!.content.trim(),
        "</skill_content>",
      ].join("\n")

      expect(output).toMatch(/^<skill_content/)
    },
  })
})
