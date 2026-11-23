# Phase 0 research notes (handoff, 2026-11-21)

> **Note (2026-11-22):** historical. The project has since moved from Next.js on Vercel to an Electron desktop app (see [../desktop.md](../desktop.md)); the Vercel notes below, the 4.5 MB body limit included, no longer apply. Requests are now checked against each provider's documented limit (../desktop.md, "Size of a request").

Research gathered before the build, kept so later phases don't repeat it.

Decisions taken after these notes (owner via coordinator): Anthropic server-side fallbacks ON in the `"default"` form; PDFs over the 4.5 MB body limit are refused with a clear message (no workaround); 5-minute Claude cache; maxDuration 300 s; inline [MISSING]/[CHECK] markers (2026-11-21). On 2026-11-22: aba-workbench will be a local app rather than a Vercel-hosted one, and the real runs are deferred. See REPORT.md.

## State
- Branch JulioCesar97DB/phase-0, base is `dev` (equals main at 252efec). Coordinator update: commit only, no push or PR until a reviewer reads the diff against dev.
- No ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment, no .env.local here or in the main checkout, `ant` CLI not installed.
- Scaffold tested in scratch: `pnpm dlx create-next-app@16.4.6 <dir> --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm --empty --disable-git --no-agent-feedback --yes` gives Next 16.4.6, React 19.3, Tailwind 4.3 via @tailwindcss/turbopack, cacheComponents: true. Next docs ship in node_modules/next/dist/docs (route handlers: 01-app/01-getting-started/15-route-handlers.md).
- Latest npm: @anthropic-ai/sdk 1.12.0, openai 7.62.0. Node 26 locally (runs .ts natively), pnpm 12.21.

## Claude (claude-api skill)
- Models: claude-opus-5-5 ($4/$20, cache read $0.20), claude-fable-5-2 ($8/$40, cache read $0.20). Cache write 1.25x (5m) or 2x (1h). Min cacheable prefix 512 tokens.
- Opus 5.5: thinking always on, effort default medium, set it explicitly. Fable 5.2: omit thinking, start effort at high. No temperature, no prefill.
- Stream with client.messages.stream(...) and finalMessage(); max_tokens ~64000.
- Caching: system = whole-assessment rules + payer facts (stable); user content = sources (text + PDF document blocks) with cache_control on the last source block; section instruction after it, no marker.
- PDF: {type:"document", source:{type:"base64", media_type:"application/pdf", data}} (inline, nothing stored at Anthropic).
- refusal: check stop_reason before reading content; mid-stream refusal means discard partial text. Server-side fallbacks (fallbacks:"default", beta server-side-fallback-2026-07-01) are beta: ask the owner before enabling.

## OpenAI (developers.openai.com/api/docs, .md pages)
- Top model gpt-6.2-astra ($8 in / $40 out / cached $0.40 / cache write $10 for 30m). Cheaper tier named by docs: gpt-6.2-sol ($2 / $10 / $0.10 / $2.50). Others: gpt-6.1-terra ($1/$5), gpt-6-luna ($0.10/$0.50).
- Use Responses API, stream:true, events response.output_text.delta, response.completed, response.incomplete, response.refusal.delta, error. Set store:false.
- GPT-6.2 appends top-level `instructions` after input and never caches them: put reusable rules in a first `developer` message.
- Caching: prompt_cache_options {mode:"explicit", ttl:"30m"} and prompt_cache_breakpoint {mode:"explicit"} on the last stable content block. Usage: input_tokens_details.cached_tokens, cache_write_tokens; output_tokens_details.reasoning_tokens.
- reasoning.effort: none is rejected on 6.2; docs say start at medium. Reserve >= 25k max_output_tokens.
- PDF: {type:"input_file", filename, file_data:"data:application/pdf;base64,...", detail:"auto"|"low"|"high"} (auto = high on 5.6+).

## Vercel (docs updated 2026-08)
- Fluid compute default. Duration: Hobby 300s default and max; Pro/Enterprise 300s default, 800s max, 1800s beta (per function, export const maxDuration in route.ts). Streaming does not extend it: the limit covers sending the streamed response. Timeout returns 504 FUNCTION_INVOCATION_TIMEOUT.
- Request body limit 4.5 MB by default (20 MiB public beta on Pro with 4 GB memory and VERCEL_SUPPORT_LARGE_REQUEST_BODY=1). Base64 PDFs in the request body count against it: open question for the owner.
- HTTP/1.1 idle connections may drop: stream heartbeats during long thinking.

## Payer facts to put in rules/
- FL Medicaid policy (Dec 2024) 2.2 functional impairment categories (safety, communication, self-stimulating, self-care); 4.2.1 Vineland-3 Comprehensive Parent Interview (+ Maladaptive domain age 3+) and BASC-3 PRQ (ages 2-18) required; 6.2.2 required contents incl. medical necessity for units requested.
- Molina guide (Jul 2026) sections 2-5, 8: impairment across multiple settings, member-specific data (frequency, rate, duration, severity), Vineland/BASC establish the broad picture and support medical necessity but are not the FBA, intensity must match availability, objective discharge criteria.
