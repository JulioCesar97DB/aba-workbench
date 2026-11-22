# Phase 0: report

> **Note (2026-11-22):** this is the historical record of Phase 0, when aba-workbench was a Next.js site meant for Vercel. The project has since moved to an Electron desktop app: the route handlers described below are gone, and `pnpm phase0` now calls the provider layer directly, with no server. The 4.5 MB request cap discussed below was replaced the same day by each provider's documented limit (Claude 128 MB per request, OpenAI 50 MB of files), checked before sending. See [../desktop.md](../desktop.md) and the README for the project as it is now.

Date: November 22, 2026. Branch `JulioCesar97DB/phase-0`, not pushed and with no pull request (that comes after the review).

## Summary

- **Phase 0 closes as a technical base, without real generations, by the owner's decision (2026-11-22).** He prefers to build the infrastructure and the app first and to test the AI output afterwards. The real runs, the measured costs and the pick of the two best outputs are left for a later step: they are postponed, not blocked. Everything is ready to run them with a single command (see "How to reproduce").
- **Built and tested without keys:**
  - our own route that talks to Claude and OpenAI;
  - the model list;
  - PDF input and the cache;
  - refusal handling, with Anthropic's *fallback* turned on;
  - the size cap;
  - the writing rules and the two invented cases;
  - the `pnpm phase0` script with its spending cap.

  `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (24 tests) and `pnpm phase0 --mock` pass.
- **The two outputs for the BCBA to judge quality:** they will be picked when the real runs are done.
- **Real spend: 0.00 USD** (Anthropic 0, OpenAI 0). The full run is estimated at about 2.6 USD for the two cases and the four models. The script never starts a call that, in the worst case, could pass the cap (5 USD by default), and it stops if it cannot know what something cost.
- **The product will be a local app, not a website on Vercel** (owner's decision, 2026-11-22). So Vercel's limits (300 s, plan, 4.5 MB) no longer constrain the product. The analysis stays below as reference and the size cap stays in the code.

## What works and what doesn't, per provider

"Tested" means I ran it or an automated test covers it. The tests use a fake `fetch`, so they check the exact request each SDK would send, with no network and no keys. What needs the real API is in the last row.

| Piece | Claude (`@anthropic-ai/sdk` 1.12) | OpenAI (`openai` 7.62, Responses API) |
| --- | --- | --- |
| Streaming generation through `POST /api/generate` | Tested: request shape per model (tests) and the full pipeline (mock). | Same |
| Model list (`GET /api/models`) | Built. With a fake key it answers 401 with our own message. | Same. OpenAI's error message is never forwarded. |
| PDFs | Tested: the PDF bytes reach the request to Anthropic unchanged (base64 `document` block; nothing is stored at the provider). | Tested the same way (`input_file` with `file_data`). |
| Prefix cache (rules + the case's sources) | Tested that the request carries exactly two breakpoints (after the rules and after the sources) and that the section request is not cached. 5-minute cache. The pre-warm sends `max_tokens: 0` without the section request. | Tested: rules in a `developer` message (never in `instructions`), two explicit breakpoints, 30-minute cache and pre-warm with `prewarm: true`. |
| Refusals | Tested: the `refusal` event carries `discard: true`, which obliges whoever receives it to discard all text from that generation. `done` also carries `complete: false`. | Same |
| Text cut off by the output limit | Tested: `max_tokens` gives `complete: false`. | Tested: `incomplete` gives `complete: false`. |
| The key is never stored or logged | It travels in the `x-provider-key` header. Nothing in the code writes the key or the body to logs. SDK logging is off (`logLevel: "off"`), so neither `ANTHROPIC_LOG` nor `OPENAI_LOG` can turn it on. The server the script starts runs without keys (see "Decisions"). | Same |
| Requests over 4.5 MB | Tested: the route answers 413 with the "paste the text instead of the PDF" message, also when the body arrives in chunks without `Content-Length`. The script fails before sending. | Same |
| What only the real API shows | That the model reads the PDFs well, that the cache is actually used, that the fallback answers as documented, the timings, the costs and the quality of the text. | The same, plus how the explicit breakpoints behave. |

**Anthropic's fallback (beta).** It is a beta feature (`server-side-fallback-2026-07-01`) that the owner decided to turn on. If the requested model declines on policy grounds, Anthropic re-runs the request on the model it recommends for that kind of refusal, inside the same call. Each output records which model wrote the text (`servedModel`), whether there was a fallback and how many tokens each attempt used.

Each attempt is charged at its own price. The two models the fallback can switch to (`claude-opus-5` and `claude-opus-4-8`) are priced. If Anthropic answered with another model, the script stops instead of counting it as zero. Some refusals have no fallback and still arrive as refusals.

The single switch is the `SERVER_SIDE_FALLBACKS` constant in `src/lib/providers/anthropic.ts`.

## Cost

**Spent: 0 USD.**

**Measured size of each request** (invented cases, PDFs generated from HTML):

| Case | PDFs (not encoded) | Full request body |
| --- | --- | --- |
| Mateo | 200,160 bytes (2 PDFs: a 2-page Vineland-3 and a 1-page PRQ) | 283,830 bytes (0.28 MB) |
| Sofía | 202,851 bytes (2 PDFs, 3 pages) | 288,398 bytes (0.29 MB) |

**Estimate per section (not measured).** Assumptions:
- About 14,500 input tokens. About 13,000 of them are cacheable prefix: 3,100 of rules, 4,300 of case notes and about 6,000 for the two PDFs, which add up to three pages and count text and image. The other 1,200 are the section request.
- About 8,000 output tokens: about 2,000 of text (900 to 1,500 words) plus about 6,000 of reasoning. **This is the most uncertain number**: reasoning can range from 3,000 to 15,000 tokens.

| Model | Price per million (input / cache write / cache read / output) | First section (writes the cache) | Later sections (read the cache) |
| --- | --- | --- | --- |
| claude-opus-5-5 | 4 / 5 / 0.20 / 20 | ~0.23 USD | ~0.17 USD |
| claude-fable-5-2 | 8 / 10 / 0.20 / 40 | ~0.46 USD | ~0.33 USD |
| gpt-6.2-sol | 2 / 2.50 / 0.10 / 10 | ~0.12 USD | ~0.08 USD |
| gpt-6.2-astra | 8 / 10 / 0.40 / 40 | ~0.46 USD | ~0.34 USD |

Output dominates the cost; caching saves little by comparison because the prefix is short.

**Estimate per full assessment (not measured).** Assumptions: 9 narrative sections as long as Medical Necessity, plus the 12 behaviors, 15 replacement skills and 20 interventions in groups of about 5 per call (about 10 calls with similar output). In total, about 19 calls sharing the same cached prefix.
- claude-opus-5-5: ~3.2 USD
- claude-fable-5-2: ~6.4 USD
- gpt-6.2-sol: ~1.6 USD
- gpt-6.2-astra: ~6.5 USD

With the uncertainty in reasoning, any of these figures can be half or double. If she lets more than 5 minutes pass between sections, Claude's cache expires and is written again. That costs about 0.07 USD more each time on Opus and 0.13 USD on Fable.

**The pending run and its cap.** Before each call, the script computes its worst case:
- all input at the cache-write price, twice because there is a pre-warm;
- the 32,000 output tokens allowed;
- on Claude, one more full attempt on the fallback model.

The call starts only if that worst case fits in what is left of the cap. For these cases the worst case is 1.79 USD on Opus, 2.64 on Fable, 0.43 on Sol and 1.70 on Astra. If a call ends without saying what it cost, or a model without a price answered it, its worst case is charged and the run stops. A `--budget` that is not a positive number stops the script before it starts.

With the estimated costs all 8 calls fit, at about 2.6 USD. If the real calls cost double the estimate, the Fable call on Sofía's case would be skipped so as not to risk the cap. It can be run on its own afterwards with `--only claude-fable-5-2 --case case-b-sofia`.

Prices are in `src/lib/pricing.ts`, dated 2026-11-21, with their source.

## Vercel: limits for long responses (reference)

> **Note (2026-11-22):** the owner decided that aba-workbench will be a local app, running on the user's computer, and not a website hosted on Vercel. With that decision, the 4.5 MB per-request limit, the choice of plan and the 300 s cutoff no longer constrain the product. The code does not change: the Next.js app and its routes stay the same, and the 4.5 MB cap stays in the code (see question 4).

According to Vercel's documentation (updated August 2026), with *Fluid compute*, which is on by default:

| Plan | Default duration | Maximum |
| --- | --- | --- |
| Hobby | 300 s | 300 s |
| Pro / Enterprise | 300 s | 800 s (1,800 s in beta, configured per function) |

- **Streaming does not extend the limit.** The duration includes the time to send the response, also when it streams. Past it, Vercel cuts the function and returns `504 FUNCTION_INVOCATION_TIMEOUT`.
- **For a section that takes a few minutes.** On Hobby everything would have to finish within 5 minutes. A large model can spend one or two minutes thinking before writing. The route declares `maxDuration = 300` (`src/app/api/generate/route.ts`).
- **Connections that look idle.** While the model thinks, no text goes out. The route sends a "still alive" line every 15 seconds. It works the same locally.
- **Request size: 4.5 MB.** The size is measured before sending, and above 4.5 MB the user is asked to paste the text instead of the PDF (`src/lib/limits.ts`). A real Q-global report can weigh more than the test ones, and base64 adds 33%.

Nothing was deployed.

## Which model I would make the default on each provider

Without real outputs I cannot recommend with data. For now:

- **Claude:** `claude-fable-5-2`, which is what was decided ("the most capable"). Opus 5.5 costs half. If it writes Medical Necessity just as well, I would propose Opus 5.5 as the default.
- **OpenAI:** `gpt-6.2-astra`, the most capable according to its documentation. `gpt-6.2-sol` costs a quarter and OpenAI presents it as the balance between quality and cost; the same rule as with Claude applies.

The "most capable first" order lives in `src/lib/providers/index.ts` (`MOST_CAPABLE_FIRST`), because the providers don't order their lists by capability.

## Checking the outputs against her structure

Pending, together with the real runs. With the outputs in hand I will check each one against her structure:

1. First paragraph: names all the sources (CDE, Vineland-3, BASC-3 PRQ, FBA questionnaires, interview, observations with dates, IEP if there is one) and the areas with deficits.
2. Second paragraph: Vineland-3 scores with percentiles and levels, exactly as they appear in the report.
3. One paragraph per area, with evidence from the CDE, the parents and direct observation, and what ABA will do for that area.
4. Closing: why all of this supports medical necessity and how ABA will improve those deficits.

I will also check "nothing invented" against the gaps planted on purpose in each case (they are also in each `case.json`, which is not sent to the model):

| Case | Planted gap | What a good output should do | Does a rule anticipate it? |
| --- | --- | --- | --- |
| Mateo, 4 | The Vineland-3 has no Socialization percentile (score 64). | Mark `[MISSING: ...]` and not compute the percentile. | Yes, a general rule ("do not compute missing scores"). It tests whether the model follows it. |
| Mateo | There is nothing written from the VPK: only what the teacher told the mother, and the school observation never happened. | Present school as the mother's account, without describing a school observation. | Yes, the general rule on what is known only second-hand. |
| Mateo (new) | The BASC-3 PRQ has no administration date; the other instruments are dated 10/02/2026. | Not give the PRQ a date; mark it as missing. | No: no rule mentions it. |
| Sofía, 9 | The CDE gives the diagnoses but not the autism severity level. | Mark it as missing and not write "Level 1". | Indirectly: the Molina facts say a CDE without a severity level is a problem. |
| Sofía | The school did not let the BCBA observe. | Use the IEP and the mother, attributed, without inventing a school observation. | Yes, the general rule on what is known only second-hand. |

Other tests the cases carry: Mateo's interview is in Spanish (the output must come out in English) and Sofía has an IEP, medication and other services.

## Changes after the review (rounds 1 and 2)

- **Spending cap.** It now fails closed:
  - the fallback models have a price;
  - an unknown cost stops the run;
  - a misspelled `--budget` is an error;
  - both `--option=value` and `--option value` are accepted;
  - the worst case uses the full output allowance.
- **Rules.** They no longer give away a gap. The missing-data marker example is now a kind of gap that matches none of the planted ones: a missing frequency on a scatterplot, a tool neither case uses (round 2; the round-1 example, a missing administration date, matched Mateo's new gap). Two other examples that resembled the cases were removed, and Mateo gained a gap that no rule anticipates. Each planted gap in `case.json` now lists its keywords and the rules files that anticipate it, and a test fails if the keywords show up in any other rules file.
- **Payer facts.** The payer file says only what the two texts say, and Molina's complaints are grouped as Molina groups them (CDE and request). How to read the Vineland-3 and PRQ scores moved to `rules/instruments.md`, which states its source and is marked as pending confirmation by the BCBA.
- **Incomplete outputs.** A cut-off, failed or refused output is no longer saved as a draft: the `.md` says "INCOMPLETE" and any partial text goes apart (`.partial.md`). On a refusal nothing is kept. Discarding the text on a refusal is now part of the provider contract (`discard: true`), not just the script's.
- **Script keys.** They go in `.env.phase0`, not `.env.local`. Next loads `.env.local` into the server, and the script now refuses to start the server if it finds keys in the files Next reads.
- **Tests.** 24 tests with `node:test` (`pnpm test`), with no keys and no network.
- **Route.** The size cap is counted while the body is read, also when it arrives in chunks. An error loading the rules answers with a JSON error instead of a shapeless 500. SDK logging is off.

## Small decisions I made (all easy to change)

- **Project.** `create-next-app` 16.4.6 defaults: `src/` folder, ESLint, Cache Components and the `AGENTS.md` that Next writes for agents. I added `"type": "module"`. Scripts and tests run on Node's native TypeScript (Node 24 or later), with no extra dependencies. For that, relative imports inside `src/lib` carry the `.ts` extension.
- **Route contract.**
  - `POST /api/generate` with the key in the `x-provider-key` header. It answers with server-sent events (`meta`, `status`, `text`, `fallback`, `refusal`, `done`, `error`).
  - `done.complete` says whether the text is usable.
  - `GET /api/models?provider=...` returns the list and the default model.
  - `mode: "prewarm"` writes the cache without generating text.
- **Prompts.** The general rules, the payer rules and the instrument rules go first, then the case's sources, and last the section's rules. That way the cache serves every section of a case.
- **Reasoning effort.** `high` on Claude (Opus 5.5 defaults to `medium`) and `medium` on OpenAI (their documented starting point for GPT-6.2). Output cap of 32,000 tokens.
- **OpenAI.** Responses API with `store: false`.
- **PDFs inside the request**, not uploaded to the provider.
- **Mock provider** only with `ABA_ENABLE_MOCK_PROVIDER=1` (`pnpm phase0 --mock`).
- **Outputs.** Each run writes `docs/phase0/outputs/<case>/<model>.md` and `.json` (tokens, cost, timings, rules versions, fallback, status), plus a `runs.json`. The mock's output goes to `tmp/`, which is in `.gitignore`.
- **Invented cases.** The surnames are "Ficticio" and "Inventada" and the BCBA is "Daniela Muestra". The PDFs come from HTML printed with Chrome (`scripts/render-fixture-pdfs.mts`).
- **Language.** Everything in the repository is in English (owner's decision, 2026-11-22). The only Spanish is test data on purpose: Mateo's parent interview notes and two short quotes in his observation notes, to check that the output comes out in English.
- **License.** Apache 2.0 in its own commit (unmodified `LICENSE`, `package.json` and README), by the owner's decision. `.impeccable/`, a local configuration of a design tool, stays out of the repository.

## Open questions for the owner

1. **Claude cache lifetime.** The 5-minute cache costs 1.25 times the input to write; the 1-hour one, 2 times. If she lets more than 5 minutes pass between sections, the 5-minute cache expires and the next section pays the full input again. (a) 5 minutes (current), (b) 1 hour, or (c) decide in Phase 1 by measuring her real pace? When the runs are done, the cache write and read tokens of each call will be in the `.json` files.
2. **Missing-data markers.** (a) Only `[MISSING: ...]` and `[CHECK: ...]` inside the text (current), (b) a separate list of gaps below the text, or (c) both?
3. **Default model if quality ties.** If Opus 5.5 or Sol write as well as Fable 5.2 or Astra, (a) do we keep the most capable as the default, as decided, or (b) the one that costs half or a quarter?
4. **The 4.5 MB cap with the local app.** *(Answered 2026-11-22: replaced by each provider's documented limit; see ../desktop.md.)* Vercel no longer imposes it. (a) Keep it as it is, (b) raise it to a value that covers her real PDFs (if she tells us how much a typical Vineland-3 and BASC-3 weigh, just the size), or (c) remove it?
5. **Reading the instruments.** `rules/instruments.md` explains how to read the Vineland-3 and the BASC-3 PRQ (means, standard deviations, the direction of each scale). It does not come from the payers. (a) Does the BCBA review it now, or (b) in Phase 1?

## How to reproduce

```sh
pnpm install && pnpm build
pnpm test                                   # 24 tests, no keys or network
pnpm phase0 --mock                          # full pipeline with the mock provider, no cost
cp .env.phase0.example .env.phase0          # and set ANTHROPIC_API_KEY and OPENAI_API_KEY (not in .env.local)
pnpm phase0                                 # real runs, 5 USD cap
pnpm phase0 --only claude-opus-5-5 --case case-a-mateo   # a single combination
```

## What is left (postponed by the owner)

When the real runs are decided:

1. Run `pnpm phase0`.
2. Save the texts and their `.json` files in `docs/phase0/outputs/`.
3. Check each output against her structure and against the gaps.
4. Pick the two best.
5. Replace this report's estimates with what was measured: cost per section, timings and cache tokens.
