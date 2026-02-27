# Signal Integration Branch

**Branch:** `signal-integration`
**Base:** `upstream/main`
**Purpose:** Combined integration/run branch merging all signal PR branches. Not a PR branch — used for local testing and running with all patches applied.

**IMPORTANT:** Never rebase this branch. To pick up upstream changes, rebuild from scratch using the merge order below.

## Tracked PRs

| #     | Branch                        | Title                                                                         | Status |
| ----- | ----------------------------- | ----------------------------------------------------------------------------- | ------ |
| 27104 | signal-block-streaming-cap    | fix(signal): declare blockStreaming capability                                | Open   |
| 27108 | signal-mention-strip-patterns | fix(signal): add mention strip patterns for object replacement character      | Open   |
| 27107 | signal-groups-dock-adapter    | fix(signal): add groups dock adapter for group mention/tool policy            | Open   |
| 27144 | signal-rpc-hardening          | feat(signal): add typed RPC errors and retry with backoff                     | Open   |
| 27149 | signal-ack-reactions          | fix(signal): harden reaction error handling and require explicit targetAuthor | Open   |
| 27147 | signal-directory-groups       | feat(signal): add directory and group lookup RPCs with plugin adapter         | Open   |
| 27145 | signal-outbound-edit          | feat(signal): add outbound message editing and deletion                       | Open   |
| 27148 | signal-outbound-mentions      | feat(signal): add outbound native mention support                             | Open   |
| 27146 | signal-sticker-outbound       | feat(signal): add outbound sticker support and sticker-search action          | Open   |
| 27169 | signal-silent-sends           | feat(signal): support silent sends via noUrgent RPC parameter                 | Open   |
| 27155 | signal-tcp-socket             | feat(signal): add persistent TCP socket transport for signal-cli RPC          | Open   |
| 27171 | signal-group-management       | feat(signal): add group management and member info actions                    | Open   |

## Merge Order

Branches are merged in this order (fixes first, then features building on each other):

1. signal-block-streaming-cap (clean)
2. signal-mention-strip-patterns (clean)
3. signal-groups-dock-adapter (conflict: dock.ts — keep both mentions + groups)
4. signal-rpc-hardening (clean)
5. signal-ack-reactions (clean)
6. signal-directory-groups (clean)
7. signal-outbound-edit (conflicts: channel.ts caps, schema.labels — keep both)
8. signal-outbound-mentions (clean)
9. signal-sticker-outbound (conflicts: signal.ts, schema.help/labels/types, zod-schema, send.ts — combine all additive)
10. signal-silent-sends (conflict: send.ts opts + params — keep both mentions + silent)
11. signal-tcp-socket (conflicts: schema.help/labels, client.ts — keep both + socket registry)
12. signal-group-management (conflicts: dock.ts, actions.test.ts, signal.ts, schema.labels, types, zod-schema — combine all additive)

## Rebuild Instructions

```bash
git fetch upstream main && git fetch origin
git checkout -B signal-integration upstream/main
for branch in \
  signal-block-streaming-cap \
  signal-mention-strip-patterns \
  signal-groups-dock-adapter \
  signal-rpc-hardening \
  signal-ack-reactions \
  signal-directory-groups \
  signal-outbound-edit \
  signal-outbound-mentions \
  signal-sticker-outbound \
  signal-silent-sends \
  signal-tcp-socket \
  signal-group-management; do
  git merge "origin/$branch" --no-edit || echo "CONFLICT in $branch — resolve and git add + git commit --no-edit"
done
```

## Post-merge Fixups

After resolving all conflicts, check for:

- Duplicate function declarations (e.g. `readSignalRecipientParam`) — remove duplicates
- Extra closing braces `}` from merge artifacts
- Run: `pnpm test -- src/channels/plugins/actions/actions.test.ts src/signal/send.rpc.test.ts src/signal/send-reactions.test.ts src/signal/send.stickers.test.ts src/signal/client.test.ts src/config/schema.help.quality.test.ts`
