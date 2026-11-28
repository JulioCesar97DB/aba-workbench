# The plan (step 3, "Plan")

The Plan step turns the case map into her plan, in her order: one block of **Hypothesis Based Interventions** per function, the **replacement** and **skills acquisition** programs, the **Interventions** glossary and the **caregiver goals**. The owner accepted the Plan step proposal whole on 2026-11-28 (32 decisions, D1 to D32). This document describes what is built: **PR 1, the plan by hand**. She writes her plan, decides on every item, gets the checks before QA as she writes, and copies each ABA Matrix field. No AI request is made. The AI's proposal (PR 2), its evaluation (PR 3) and the plan in the report's sections (PR 4) come later.

## Storage: inside the case map, schema version 6 (D1, D2, D5)

The plan lives in the case map: six more parts inside `caseMap.parts`, each with the same `{ currentVersion, approvedVersion, versions[] }` shape as the map's parts and the same machinery (`src/main/case-map.ts`). That covers versions, provenance per claim, the editing pass that changes in place while she types, autosave, and failed saves kept with "Try again". They are listed apart from the map's own parts (`PLAN_PARTS` in `src/shared/plan.ts`), so the map's screen, its "approved out of parts" count and its step state do not change.

| Part | Id prefix | What one item is |
| --- | --- | --- |
| `strategies` | `stg` | A named strategy or teaching procedure (kind `antecedent`, `teaching` or `consequence`), with structured parameters. An antecedent strategy names the function blocks it is preventive in (`functions`). |
| `interventions` | `hbi` | A management entry of a function block: its `Positive` paragraph, or one `Maladaptive` entry for one behavior or one group of the map, with `safetyFirst` and the strategies it names. |
| `programs` | `prg` | A replacement (with its `function` and what it gets the child, `outcome`) or a skill program: title, definition, numbered procedure, targets, measure, baseline sessions, the caregiver's report, mastery category, parameters, and her overrides. |
| `glossary` | `glo` | One entry for one strategy, by its id: a definition sentence and how it is done with this child. Its name is the strategy's (D15). |
| `caregiverGoals` | `cgg` | One goal block of Family/Caregiver Involvement (D9): title, procedure, baseline (0, 10 or 20%). |
| `planInputs` | `plan` (one item) | The weekly hours of 97153 she types (D10), and her override of the program target. |

**The function blocks are never stored (D7).** Code computes which blocks exist and which behaviors each lists (`functionBlocks`). There is one block for each of her five functions (Tangibles, Attention, Escape, Sensory, Automatic Reinforcement, in that order) that is primary or secondary for a behavior of the map. A behavior sits in every block of its functions. A group of the map whose members are all in a block is one unit, so it gets one management entry. A behavior the map marks dangerous (a risk names it, it has risks, or its barriers include Safety) asks for the safety step first. A replacement belongs to the block of its own `function`, and a preventive strategy to the blocks its `functions` name. The blocks read the behaviors part as shown. When that part is not approved, the screen says so.

**A decision per item (D2).** Every plan item but the inputs carries `decision` (`"proposed"`, `"accepted"` or `"rejected"`), `decidedAt` and `by` (`"her"` for what she added, `"ai"` for the AI's proposals from PR 2 on). An unknown decision a newer app writes counts as proposed. A decision is an edit: it goes into the part's editing pass, so history records who decided what without a version per click, and an AI version never changes. In plan parts the item decision is the approval: the map's part approval (`approveMapPart`, `setMapPartVersion`) refuses plan parts.

- **Editing accepts (D3).** A save of her form accepts the item. The screen shows "Corregida por ti" for an AI item she edited and "Escrita por ti" for one she added.
- **Rejecting keeps (D4).** A rejected item stays in the version, folded under "Rechazadas (n)". "Recuperar" brings it back undecided.
- **"Aceptar lo que queda"** accepts every proposed item of a view (a block, the programs, the glossary, the goals) and never one she rejected (`onlyUndecided`).

**What leaves the plan** goes through one function, `acceptedPlan`: the accepted items of the version shown, with the references pruned. A management entry keeps only accepted strategies, and a glossary entry goes only with an accepted strategy. The copy reads only this. PR 4's report block will read it too.

**Schema version 6 (D5).** `MIGRATIONS[5]` adds nothing: a version 5 file reads as version 6 with no plan, and is written as version 6 on its next save. The version is raised because an older app that kept unknown parts would still let her change the map under a plan it cannot see. "A newer file is never written to" stops that. The stored schema checks every plan part's items and their limits: 60 strategies, 155 management entries (five blocks of a Positive and up to 30 entries), 60 programs, 80 glossary entries, 6 goals, 12 parameters, 20 steps, 30 targets and 10 baseline sessions. A file past them is damaged, never half read. Keys and words a newer app writes are kept as they are.

**Copied marks (D23)** are in `caseMap.planCopied`, by field id: `copiedAt`, the plan parts' versions then, and a fingerprint (FNV-1a) of the text copied. A field is "✓ Copiado" while the text it would copy now has the same fingerprint, so any change to what it renders takes the mark away. The fingerprint is used because an editing pass keeps the same version number while she types.

## What code computes (§4.4: D10 to D13)

`src/shared/plan-compute.ts`. Each value is computed when it is shown or copied and never stored, so it cannot go stale. She can override a computed value for a case (the coordinator's answer of 2026-11-28): the override is her value, stored and marked hers, and it wins. Clearing it brings the computation back.

- **The program count (D10).** About 25 under age 5. From 5, one per weekly hour she types on the plan's rail ("20", "20 h", "20 horas"). With no hours, 30, her usual plan, with an open item that says so; hours the app cannot read are said so, not taken for none. The age is the map's client age when it reads plainly ("6 years 4 months", "6 años", "6;4"), else the case's own. Hours are a plain number from 1 to 60, and her override a whole number from 1 to 99.
- **Skill baselines (D11).** Each session's percent is correct over opportunities, both plain whole numbers. The baseline is the mean of the sessions, rounded to the nearest 10% exactly (a common denominator, so a half always rounds up). A session that gave no opportunity (0 of 0) is left out of the mean. A session that cannot be read gives no baseline (`[MISSING]`), and the report is not used in its place. With no sessions, or none that gave an opportunity, the caregiver's report gives it, rounded the same way, with a `[CHECK]`.
- **Mastery (D12).** It comes from the category: 90% general, 95% safety, 100% crossing the street. Caregiver goals are 95% (reading 4).
- **Parameters (D13).** Each parameter has a `label`, a `role` from a closed list (prompt delay or wait, calm before delivery, proximity distance, interval, duration, count, other), a `value` and a `unit` (s, min, ft, count, %, other). The role was settled by the coordinator, 2026-11-28, so the clash check never guesses from her words. "Immediately", "at once" and their Spanish read as 0 s.
- **The glossary (D15)** is in alphabetical order, case and accents aside, each entry named as its strategy.

## The code checks, "Antes de QA" (§5: D19 to D21)

`src/shared/plan-checks.ts` runs on every plan item that is not rejected, hers included, after every change. The checks are soft: they warn, she can accept with them open, and nothing is rewritten. They are kept cautious (the T2 and T3 lesson). When the code cannot read a number, a threshold or a role plainly, it says nothing.

- **Clash (D20).** The code reads a behavior's latency only from an onset or definition clause that says the child does not start ("does not begin within 5 seconds", "no empieza en 5 s"); a bare "within 10 seconds" (a rate window, or when a behavior begins) gives none, its offset from its offset (or the definition's ending clause), and an elopement's distance only when the behavior is an elopement by its words. Each must give exactly one value. Linked items are the block's preventive strategies, the strategies named by the entries that cover the behavior, and the block's replacements. A `prompt-delay` shorter than the latency, a `calm-before-delivery` shorter than the offset, or a `proximity` farther than the elopement distance is flagged.
- **Replacement (§5.2).** It flags a block with no replacement, a block whose replacements all get another function's outcome (Escape: a break or help; Tangibles: an item or waiting; Attention: attention; Sensory and Automatic: a competing activity), a replacement whose outcome is "other" (check it), and one whose outcome is not chosen yet (say what it gets).
- **Extinction and punishment (D21).** The code looks for her never-list (`rules/interventions.md`: response blocking, hand-over-hand, planned ignoring, time-out, response cost, overcorrection, restraint, seclusion), the names of extinction and punishment, reprimands, "ignore the behavior", "do not allow escape" and the removal of privileges, in English and in Spanish, on every plan text and her confirmed HBI intro. A name is skipped only when a negation governs it: right before it, as whole words with at most three small words between ("does not use planned ignoring", "no extinction", "instead of time-out", "nunca se usa castigo"), or right after it ("is not used", "procedures are never used", "is avoided", "no se usa"). The "ni" of "niño" is no negation, and a negation of the child's behavior earlier in the clause ("If he does not stop within 10 seconds, the RBT uses planned ignoring") does not reach the name. A physical prompt, "self-restraint", "restraint-free", "time out in the community" and "aislamiento social" are not flagged.
- **The cheap ones of §5.4.** A behavior or group of a block with no management entry, or with two. A dangerous one without the safety step first. A strategy with no glossary entry, and an entry for no strategy. A number with a unit in an entry that is not among its strategy's parameters (D13). An entry written before its strategy changed. An "Implementation:" label. Fewer than three openings, once the glossary has five entries. A task analysis outside 4 to 6 steps. A typed baseline that is not a multiple of 10%.

Not built (left on purpose): the count far from its target (it would warn all the while she writes; the programs' header shows "n de ~target"), and child phrases not in English (too many false alarms for a code check). The AI review (PR 2) covers the subtle cases.

Each finding names its view, so it shows on its item, in the rail of its view ("Antes de QA · Escape · 2"), and in "Antes de QA" with "Ver".

## Copy for ABA Matrix (D22, D23)

`src/shared/plan-copy.ts` renders plain text, no markdown, from `acceptedPlan` only. The same function runs in the main process, for what goes to the clipboard and the fingerprints, and in the interface, for what it shows. Fields, in ABA Matrix's order:

- **11 and 12**, per program: Name, Definition, Procedure (numbered steps, then "Targets: …"), Baseline ("A baseline of 10%.", or the caregiver's with a `[CHECK]`, or `[MISSING: baseline]`). The measure and the mastery criterion are shown as values she enters.
- **14**: the Introduction, then per function block Behaviors, Preventive Strategies, Replacement Skills and Management Strategies ("Positive:" then "Maladaptive:", one entry per behavior or group in the block's order), and "the whole block", until her paste test says how ABA Matrix's fields are (reading 5).
- **15**: the glossary, one field, alphabetical, "Name: definition implementation".
- **16**: per caregiver goal, Title, Procedure, Baseline. Mastery 95% is a value she enters.

Tables 9 and the STO and LTO ladders are never written: ABA Matrix builds them. `copyPlanFields(caseId, fieldIds)` renders from what is saved, writes the clipboard as plain text, then marks the fields. Several ids that make one block go as the block's whole text. Revisión y copia lists the same fields with the same marks.

## Her plan standing instructions and the HBI intro (D16, D17)

`instructions.json` has a `"plan"` entry: her usual parameters, as text (offered on the plan's rail, saved like a section's instructions; the AI reads them from PR 2 on). The same entry keeps `hbiIntro: { text, confirmedAt }`, the intro she confirmed once for all her cases. Until she confirms, our draft (`HBI_INTRO_DRAFT`, in our words) shows as a proposal, and the copy marks it `[CHECK: confirm the intro]`. Once confirmed, code puts her text at the top of section 14's copy. An intro she confirmed before is kept in `hbiIntroHistory` when she replaces it.

## The screen

`#/cases/<id>/interventions` (path unchanged, T13), `src/renderer/src/screens/Plan.tsx` with `src/renderer/src/plan/`. Views, by `?view=`: `fn:<function>`, `programs`, `glossary`, `goals`, `checks` ("Antes de QA"), `copy` ("Copiar para ABA Matrix"). An item named in `&item=` is scrolled to.

- **Empty**: the two ways as cards. "Escríbelo tú, función por función" offers "Empezar por <first block>" and "Añadir un programa". "Que la IA proponga todo el plan" says "En la próxima versión". Below them, what the plan uses from the map (functions and their behaviors). The rail shows what is approved in the map, "Cuántos programas" (weekly hours, the target and the open item), the HBI intro, her parameters, and "Siguiente paso" (the report).
- **Every item is in a view** (`viewItems`): a block's strategies, replacements and entries, the programs, the glossary with the strategies no block shows (teaching and consequence procedures), the goals. A preventive strategy keeps at least one block.
- **Keyboard**: after Aceptar, Recuperar or Listo the focus is on the item's heading, after Rechazar on "Rechazadas"; a form takes the focus on its first field. A plan item whose save failed opens its form again with what she typed.
- **A view**: the step header ("Paso 3 de 5 · Plan", the view's name, "n de m decididas", and "Aceptar lo que queda (n)" as the screen's primary action), the two-ways bar ("A mano" active on the left, "Con la IA" saying it comes next), and the tabs (one per block, decided/total; a function with plan items but no behavior now is dashed, "sin conductas").
- **A function block**: Behaviors (from the map), then three columns. Preventive strategies are cards with their parameters. Replacements have "Abrir el programa". Management has the Positive, then each behavior or group of the block, with its entry or a dashed "Escribir su manejo", marked dangerous where the map says so. Each card has its state chip, its checks, and Aceptar · Editar · Rechazar. Editar opens the form in place, saved as she types. The forms are the map's autosave path ("map-item" failed saves), so what she types is never lost.
- **Programs**: replacements, then skills ("Programas · n de ~target"), and the one chosen in full: sessions with each percent, the baseline sentence and where it came from, the mastery criterion.
- **Glossary**: the strategies without an entry ("Escribir su entrada"), the entries in alphabetical order, and the teaching procedures.
- **Caregiver goals**, **Antes de QA** (by kind, each with "Ver"), and **Copiar para ABA Matrix** (by section, one row per program, block or goal with its fields copied, opening on its fields as mockup 07; the plain text exactly as pasted, "Copiar este campo", "Copiar el bloque X entero", where to paste it, and what is not copied).
- **The sidebar** counts the plan's items decided out of its items ("18/102"). Plan is not started with none, in progress, and done once none waits. The case summary and Home say the same. Plan no longer shows "Pronto".

## Files

| File | What it holds |
| --- | --- |
| `src/shared/plan.ts` | The plan's parts, item shapes, limits and closed lists; the computed blocks; `acceptedPlan`; the summary; the HBI intro draft; fingerprints |
| `src/shared/plan-compute.ts` | The computations of §4.4 |
| `src/shared/plan-checks.ts` | The code checks of §5 |
| `src/shared/plan-copy.ts` | The plain text of each ABA Matrix field, and the copied marks |
| `src/main/case-map.ts` | The plan's stored schema and inputs, decisions (`decidePlanItems`), copied marks, `planView` |
| `src/main/case-map-service.ts` | `getPlan`, `decide`, `copyPlanFields`, `confirmHbiIntro` |
| `src/main/instructions.ts` | The `"plan"` entry and the confirmed intro |
| `src/renderer/src/screens/Plan.tsx`, `src/renderer/src/plan/` | The screen, its forms, cards, copy list and Revisión y copia's list |
| `tests/plan.test.ts` | Schema 6, decisions, blocks, every computation, every check (texts that should pass and should fail), copy |
| `e2e/plan.e2e.ts`, `e2e/plan-flow.ts`, `e2e/plan-fixture.ts` | The window tests on an invented case |
