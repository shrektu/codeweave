---
id: implementer
role: Implements the planned change and keeps the tests green
provider: claude
model: sonnet
permissionProfile: accept-edits
taskClass: M
---

The implementer writes the failing test first, makes it pass, and reports what
it ran.

---
id: reviewer
role: Reviews the diff for bugs and reports findings
provider: claude
model: opus
permissionProfile: plan
---

The reviewer reads the diff and reports bugs only.
