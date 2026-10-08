import {
  deepVariableReplacer,
  getByPath,
  blobToBase64,
} from "./common.function";

import { TYPE_PROVIDER } from "@/types";
import curl2Json from "@bany/curl-to-json";

export interface STTParams {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  audio: File | Blob;
  prompt?: string;
  terms?: string[];
  signal?: AbortSignal;
}

/**
 * Transcribes audio and returns either the transcription or an error/warning message as a single string.
 */
export async function fetchSTT(params: STTParams): Promise<string> {
  let warnings: string[] = [];

  try {
    const {
      provider,
      selectedProvider,
      audio,
      prompt,
      terms = [],
      signal,
    } = params;

    if (!provider) throw new Error("Provider not provided");
    if (!selectedProvider) throw new Error("Selected provider not provided");
    if (!audio) throw new Error("Audio file is required");
    throwIfAborted(signal);

    let curlJson: any;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    // Validate audio file
    const file = audio as File;
    if (file.size === 0) throw new Error("Audio file is empty");
    // maximum size of 10MB
    // const maxSize = 10 * 1024 * 1024;
    // if (file.size > maxSize) {
    //   warnings.push("Audio exceeds 10MB limit");
    // }

    // Build variable map
    const allVariables: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
      STT_PROMPT: prompt ?? "",
      STT_TERMS: terms.join(", "),
      STT_TERMS_JSON: JSON.stringify(terms),
    };

    if (provider.id === "azure-mai-transcribe") {
      if (!allVariables.API_KEY?.trim()) {
        throw new Error("Azure Speech API key is required.");
      }
      const endpoint = allVariables.ENDPOINT?.trim() ?? "";
      let parsedEndpoint: URL;
      try {
        parsedEndpoint = new URL(
          endpoint.includes("://") ? endpoint : `https://${endpoint}`
        );
      } catch {
        throw new Error("Use the Azure Speech resource endpoint, for example https://your-resource.cognitiveservices.azure.com.");
      }
      if (
        parsedEndpoint.protocol !== "https:" ||
        !parsedEndpoint.hostname.endsWith(".cognitiveservices.azure.com") ||
        parsedEndpoint.pathname !== "/" || parsedEndpoint.search || parsedEndpoint.hash ||
        parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.port
      ) {
        throw new Error("Use the Azure Speech resource endpoint, not a Project or Azure OpenAI endpoint.");
      }
      allVariables.ENDPOINT = parsedEndpoint.hostname;
    }

    // Prepare request
    // curl-to-json lowercases placeholders in URL hostnames.
    const urlVariables = {
      ...allVariables,
      ...Object.fromEntries(
        Object.entries(allVariables).map(([key, value]) => [key.toLowerCase(), value])
      ),
    };
    let url = deepVariableReplacer(curlJson.url || "", urlVariables);
    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    const formData = deepVariableReplacer(curlJson.form || {}, allVariables);

    // To Check if API accepts Binary Data
    const isBinaryUpload = provider.curl.includes("--data-binary");
    // Fetch URL Params
    const rawParams = curlJson.params || {};
    // Decode Them
    const decodedParams = Object.fromEntries(
      Object.entries(rawParams).map(([key, value]) => [
        key,
        typeof value === "string" ? decodeURIComponent(value) : "",
      ])
    );
    // Get the Parameters from allVariables
    const replacedParams = deepVariableReplacer(decodedParams, allVariables);

    // Add query parameters to URL
    const queryString = new URLSearchParams(replacedParams).toString();
    if (queryString) {
      url += (url.includes("?") ? "&" : "?") + queryString;
    }

    let finalHeaders = { ...headers };
    let body: FormData | string | Blob;

    const isForm =
      provider.curl.includes("-F ") || provider.curl.includes("--form");
    if (isForm) {
      const form = new FormData();
      const freshBlob = new Blob([await audio.arrayBuffer()], {
        type: audio.type,
      });
      throwIfAborted(signal);
      const fields = Object.entries(formData).map(([key, val]): [string, unknown] => {
        if (typeof val === "string" && /^\d+$/.test(key)) {
          const separator = val.indexOf("=");
          return separator < 0
            ? [val, ""]
            : [val.slice(0, separator), val.slice(separator + 1)];
        }
        return [key, val];
      });
      const audioField = fields.find(([, val]) =>
        typeof val === "string" && /^(?:@)?\{\{AUDIO\}\}$/.test(val.trim())
      )?.[0] ?? "file";
      form.append(audioField, freshBlob, audioUploadFilename(audio.type));
      const headerKeys = Object.keys(headers).map((k) =>
        k.toUpperCase().replace(/[-_]/g, "")
      );

      for (const [key, val] of fields) {
        if (
          key === audioField || !val ||
          headerKeys.includes(key.toUpperCase().replace(/[-_]/g, ""))
        ) continue;
        form.append(key, val as string | Blob);
      }
      for (const key of Object.keys(finalHeaders)) {
        if (key.toLowerCase() === "content-type") delete finalHeaders[key];
      }
      body = form;
    } else if (isBinaryUpload) {
      // Deepgram-style: raw binary body
      body = new Blob([await audio.arrayBuffer()], {
        type: audio.type,
      });
      throwIfAborted(signal);
    } else {
      // Google-style: JSON payload with base64
      allVariables.AUDIO = await blobToBase64(audio);
      throwIfAborted(signal);
      const dataObj = curlJson.data ? { ...curlJson.data } : {};
      body = JSON.stringify(deepVariableReplacer(dataObj, allVariables));
    }

    // Send request
    let response: Response;
    try {
      response = await fetch(url, {
        method: curlJson.method || "POST",
        headers: finalHeaders,
        body: curlJson.method === "GET" ? undefined : body,
        signal,
      });
    } catch (e) {
      if (signal?.aborted || isAbortLikeError(e)) {
        throw createAbortError(signal, e);
      }
      throw new Error(`Network error: ${e instanceof Error ? e.message : e}`);
    }

    if (!response.ok) {
      let errText = "";
      try {
        errText = await response.text();
      } catch {}
      let errMsg: string;
      try {
        const errObj = JSON.parse(errText);
        errMsg = errObj.message || errText;
      } catch {
        errMsg = errText || response.statusText;
      }
      throw new Error(`HTTP ${response.status}: ${errMsg}`);
    }

    const responseText = await response.text();
    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      return [...warnings, responseText.trim()].filter(Boolean).join("; ");
    }

    // Extract transcription
    const rawPath = provider.responseContentPath || "text";
    const path = rawPath.charAt(0).toLowerCase() + rawPath.slice(1);
    const transcription = (getByPath(data, path) || "").trim();

    if (!transcription) {
      return [...warnings, "No transcription found"].join("; ");
    }

    // Return transcription with any warnings
    return [...warnings, transcription].filter(Boolean).join("; ");
  } catch (err) {
    if (isAbortLikeError(err)) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg);
  }
}

function audioUploadFilename(mimeType: string): string {
  const type = mimeType.split(";", 1)[0].trim().toLowerCase();
  const extensions: Record<string, string> = {
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/vnd.wave": "wav",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/aac": "aac",
  };
  const extension = Object.prototype.hasOwnProperty.call(extensions, type)
    ? extensions[type]
    : undefined;
  if (!extension) {
    throw new Error(`Unsupported audio format: ${mimeType || "missing MIME type"}`);
  }
  return `audio.${extension}`;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

function createAbortError(signal?: AbortSignal, cause?: unknown) {
  if (isAbortLikeError(cause)) {
    return cause;
  }
  const reason =
    typeof signal?.reason === "string" && signal.reason.trim()
      ? signal.reason
      : "Speech-to-text request aborted.";
  const error = new Error(reason);
  error.name = "AbortError";
  return error;
}

function isAbortLikeError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "AbortError"
  );
}
