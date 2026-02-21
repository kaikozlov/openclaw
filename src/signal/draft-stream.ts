import { createDraftStreamLoop } from "../channels/draft-stream-loop.js";
import type { SignalTextStyleRange } from "./format.js";
import {
  deleteMessageSignal,
  editMessageSignal,
  sendMessageSignal,
  type SignalSendResult,
} from "./send.js";

const SIGNAL_STREAM_MAX_CHARS = 4000;
const DEFAULT_THROTTLE_MS = 1000;
const SIGNAL_EDIT_LIMIT_PER_MESSAGE = 10;
const SIGNAL_RESERVED_FINAL_EDITS = 2;
const DEFAULT_SIGNAL_MAX_PREVIEW_EDITS =
  SIGNAL_EDIT_LIMIT_PER_MESSAGE - SIGNAL_RESERVED_FINAL_EDITS;

type SignalDraftPreview = {
  text: string;
  textMode?: "markdown" | "plain";
  textStyles?: SignalTextStyleRange[];
};

export type SignalDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  forceNewMessage: () => void;
  messageTimestamp: () => number | undefined;
};

function resolveTimestamp(result: SignalSendResult): number | undefined {
  if (
    typeof result.timestamp === "number" &&
    Number.isFinite(result.timestamp) &&
    result.timestamp > 0
  ) {
    return Math.trunc(result.timestamp);
  }
  const parsed = Number.parseInt(result.messageId, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.trunc(parsed);
  }
  return undefined;
}

function serializeStyles(styles: SignalTextStyleRange[] | undefined): string {
  if (!styles || styles.length === 0) {
    return "";
  }
  return styles.map((style) => `${style.start}:${style.length}:${style.style}`).join("|");
}

export function createSignalDraftStream(params: {
  target: string;
  baseUrl?: string;
  account?: string;
  accountId?: string;
  maxBytes?: number;
  maxChars?: number;
  maxPreviewEdits?: number;
  throttleMs?: number;
  renderText?: (text: string) => SignalDraftPreview;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  send?: typeof sendMessageSignal;
  edit?: typeof editMessageSignal;
  remove?: typeof deleteMessageSignal;
}): SignalDraftStream {
  const maxChars = Math.min(params.maxChars ?? SIGNAL_STREAM_MAX_CHARS, SIGNAL_STREAM_MAX_CHARS);
  const maxPreviewEdits = Math.max(1, params.maxPreviewEdits ?? DEFAULT_SIGNAL_MAX_PREVIEW_EDITS);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const send = params.send ?? sendMessageSignal;
  const edit = params.edit ?? editMessageSignal;
  const remove = params.remove ?? deleteMessageSignal;

  let streamTimestamp: number | undefined;
  let lastSentText = "";
  let lastSentMode: "markdown" | "plain" = "plain";
  let lastSentStyles = "";
  let previewEditCount = 0;
  let stopped = false;

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (stopped) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return true;
    }
    if (trimmed.length > maxChars) {
      stopped = true;
      params.warn?.(`signal stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return false;
    }

    const rendered = params.renderText?.(trimmed) ?? { text: trimmed, textMode: "plain" };
    const renderedText = rendered.text.trimEnd();
    const renderedMode = rendered.textMode ?? "plain";
    const renderedStyles = serializeStyles(rendered.textStyles);
    if (!renderedText) {
      return true;
    }
    if (
      renderedText === lastSentText &&
      renderedMode === lastSentMode &&
      renderedStyles === lastSentStyles
    ) {
      return true;
    }
    const isRegressivePrefixEdit =
      typeof streamTimestamp === "number" &&
      Boolean(lastSentText) &&
      lastSentText.startsWith(renderedText) &&
      renderedText.length < lastSentText.length;
    if (isRegressivePrefixEdit) {
      // Keep preview monotonic to avoid late stale fragments rolling edits back.
      return true;
    }

    try {
      if (typeof streamTimestamp === "number") {
        if (previewEditCount >= maxPreviewEdits) {
          stopped = true;
          params.warn?.(
            `signal stream preview stopped (max preview edits reached: ${maxPreviewEdits})`,
          );
          return false;
        }
        await edit(params.target, renderedText, streamTimestamp, {
          baseUrl: params.baseUrl,
          account: params.account,
          accountId: params.accountId,
          maxBytes: params.maxBytes,
          textMode: renderedMode,
          textStyles: rendered.textStyles,
        });
        previewEditCount += 1;
      } else {
        const sent = await send(params.target, renderedText, {
          baseUrl: params.baseUrl,
          account: params.account,
          accountId: params.accountId,
          maxBytes: params.maxBytes,
          textMode: renderedMode,
          textStyles: rendered.textStyles,
        });
        const timestamp = resolveTimestamp(sent);
        if (typeof timestamp !== "number") {
          stopped = true;
          params.warn?.("signal stream preview stopped (missing timestamp from sendMessage)");
          return false;
        }
        streamTimestamp = timestamp;
      }
      lastSentText = renderedText;
      lastSentMode = renderedMode;
      lastSentStyles = renderedStyles;
      return true;
    } catch (err) {
      stopped = true;
      params.warn?.(
        `signal stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const loop = createDraftStreamLoop({
    throttleMs,
    isStopped: () => stopped,
    sendOrEditStreamMessage,
  });

  const stop = async () => {
    stopped = true;
    loop.stop();
    await loop.waitForInFlight();
  };

  const clear = async () => {
    await stop();
    const targetTimestamp = streamTimestamp;
    streamTimestamp = undefined;
    lastSentText = "";
    lastSentMode = "plain";
    lastSentStyles = "";
    previewEditCount = 0;
    if (typeof targetTimestamp !== "number") {
      return;
    }
    try {
      await remove(params.target, targetTimestamp, {
        baseUrl: params.baseUrl,
        account: params.account,
        accountId: params.accountId,
      });
    } catch (err) {
      params.warn?.(
        `signal stream preview cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const forceNewMessage = () => {
    streamTimestamp = undefined;
    lastSentText = "";
    lastSentMode = "plain";
    lastSentStyles = "";
    previewEditCount = 0;
    loop.resetPending();
  };

  params.log?.(`signal stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update: loop.update,
    flush: loop.flush,
    clear,
    stop,
    forceNewMessage,
    messageTimestamp: () => streamTimestamp,
  };
}
