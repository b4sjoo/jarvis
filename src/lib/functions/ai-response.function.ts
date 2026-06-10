import {
  buildDynamicMessages,
  deepVariableReplacer,
  extractVariables,
  getByPath,
  getStreamingContent,
  ImageInput,
} from "./common.function";
import { Message, TYPE_PROVIDER } from "@/types";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import curl2Json from "@bany/curl-to-json";
import { getResponseSettings, RESPONSE_LENGTHS, LANGUAGES } from "@/lib";
import { MARKDOWN_FORMATTING_INSTRUCTIONS } from "@/config/constants";

export interface AIResponseRequestOptions {
  timeoutMs?: number;
  maxOutputTokens?: number;
}

function buildEnhancedSystemPrompt(
  baseSystemPrompt?: string,
  applyResponseSettings = true
): string {
  const prompts: string[] = [];

  if (baseSystemPrompt) {
    prompts.push(baseSystemPrompt);
  }

  if (applyResponseSettings) {
    const responseSettings = getResponseSettings();

    const lengthOption = RESPONSE_LENGTHS.find(
      (l) => l.id === responseSettings.responseLength
    );
    if (lengthOption?.prompt?.trim()) {
      prompts.push(lengthOption.prompt);
    }

    const languageOption = LANGUAGES.find(
      (l) => l.id === responseSettings.language
    );
    if (languageOption?.prompt?.trim()) {
      prompts.push(languageOption.prompt);
    }
  }

  // Add markdown formatting instructions
  prompts.push(MARKDOWN_FORMATTING_INSTRUCTIONS);

  return prompts.join(" ");
}

export async function* fetchAIResponse(params: {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: Array<string | ImageInput>;
  signal?: AbortSignal;
  applyResponseSettings?: boolean;
  requestOptions?: AIResponseRequestOptions;
}): AsyncIterable<string> {
  let cleanupRequestSignal = () => {};

  try {
    const {
      provider,
      selectedProvider,
      systemPrompt,
      history = [],
      userMessage,
      imagesBase64 = [],
      signal,
      applyResponseSettings = true,
      requestOptions,
    } = params;
    const requestSignal = createRequestSignal(signal, requestOptions?.timeoutMs);
    cleanupRequestSignal = requestSignal.cleanup;

    // Check if already aborted
    if (requestSignal.signal?.aborted) {
      return;
    }

    const enhancedSystemPrompt = buildEnhancedSystemPrompt(
      systemPrompt,
      applyResponseSettings
    );

    if (!provider) {
      throw new Error(`Provider not provided`);
    }
    if (!selectedProvider) {
      throw new Error(`Selected provider not provided`);
    }

    let curlJson;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    const extractedVariables = extractVariables(provider.curl);
    const requiredVars = extractedVariables.filter(
      ({ key }) => key !== "SYSTEM_PROMPT" && key !== "TEXT" && key !== "IMAGE"
    );
    for (const { key } of requiredVars) {
      if (
        !selectedProvider.variables?.[key] ||
        selectedProvider.variables[key].trim() === ""
      ) {
        throw new Error(
          `Missing required variable: ${key}. Please configure it in settings.`
        );
      }
    }

    if (!userMessage) {
      throw new Error("User message is required");
    }
    if (imagesBase64.length > 0 && !provider.curl.includes("{{IMAGE}}")) {
      throw new Error(
        `Provider ${provider?.id ?? "unknown"} does not support image input`
      );
    }

    let bodyObj: any = curlJson.data
      ? JSON.parse(JSON.stringify(curlJson.data))
      : {};
    const messagesKey = Object.keys(bodyObj).find((key) =>
      ["messages", "contents", "conversation", "history"].includes(key)
    );

    if (messagesKey && Array.isArray(bodyObj[messagesKey])) {
      const finalMessages = buildDynamicMessages(
        bodyObj[messagesKey],
        history,
        userMessage,
        imagesBase64
      );
      bodyObj[messagesKey] = finalMessages;
    }

    const allVariables = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
      SYSTEM_PROMPT: enhancedSystemPrompt || "",
      IMAGE_MEDIA_TYPE: getFirstImageMediaType(imagesBase64),
    };

    bodyObj = deepVariableReplacer(bodyObj, allVariables);
    let url = deepVariableReplacer(curlJson.url || "", allVariables);
    applyAIRequestOptionsToBody(bodyObj, provider, url, requestOptions);

    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    headers["Content-Type"] = "application/json";

    if (provider?.streaming) {
      if (typeof bodyObj === "object" && bodyObj !== null) {
        const streamKey = Object.keys(bodyObj).find(
          (k) => k.toLowerCase() === "stream"
        );
        if (streamKey) {
          bodyObj[streamKey] = true;
        } else {
          bodyObj.stream = true;
        }
      }
    }

    const fetchFunction = url?.includes("http") ? fetch : tauriFetch;

    let response;
    try {
      response = await fetchFunction(url, {
        method: curlJson.method || "POST",
        headers,
        body: curlJson.method === "GET" ? undefined : JSON.stringify(bodyObj),
        signal: requestSignal.signal,
      });
    } catch (fetchError) {
      // Check if aborted
      if (
        requestSignal.signal?.aborted ||
        (fetchError instanceof Error && fetchError.name === "AbortError")
      ) {
        if (requestSignal.timedOut()) {
          throw new Error(
            `AI request timed out after ${requestOptions?.timeoutMs}ms.`
          );
        }
        return; // Silently return on abort
      }
      yield `Network error during API request: ${
        fetchError instanceof Error ? fetchError.message : "Unknown error"
      }`;
      return;
    }

    if (!response.ok) {
      let errorText = "";
      try {
        errorText = await response.text();
      } catch {}
      yield `API request failed: ${response.status} ${response.statusText}${
        errorText ? ` - ${errorText}` : ""
      }`;
      return;
    }

    if (!provider?.streaming) {
      let json;
      try {
        json = await response.json();
      } catch (parseError) {
        yield `Failed to parse non-streaming response: ${
          parseError instanceof Error ? parseError.message : "Unknown error"
        }`;
        return;
      }
      const content =
        getByPath(json, provider?.responseContentPath || "") || "";
      yield content;
      return;
    }

    if (!response.body) {
      yield "Streaming not supported or response body missing";
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      // Check if aborted
      if (requestSignal.signal?.aborted) {
        reader.cancel();
        if (requestSignal.timedOut()) {
          throw new Error(
            `AI request timed out after ${requestOptions?.timeoutMs}ms.`
          );
        }
        return;
      }

      let readResult;
      try {
        readResult = await reader.read();
      } catch (readError) {
        // Check if aborted
        if (
          requestSignal.signal?.aborted ||
          (readError instanceof Error && readError.name === "AbortError")
        ) {
          if (requestSignal.timedOut()) {
            throw new Error(
              `AI request timed out after ${requestOptions?.timeoutMs}ms.`
            );
          }
          return; // Silently return on abort
        }
        yield `Error reading stream: ${
          readError instanceof Error ? readError.message : "Unknown error"
        }`;
        return;
      }
      const { done, value } = readResult;
      if (done) break;

      // Check if aborted before processing
      if (requestSignal.signal?.aborted) {
        reader.cancel();
        if (requestSignal.timedOut()) {
          throw new Error(
            `AI request timed out after ${requestOptions?.timeoutMs}ms.`
          );
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const trimmed = line.substring(5).trim();
          if (!trimmed || trimmed === "[DONE]") continue;
          try {
            const parsed = JSON.parse(trimmed);
            const delta = getStreamingContent(
              parsed,
              provider?.responseContentPath || ""
            );
            if (delta) {
              yield delta;
            }
          } catch (e) {
            // Ignore parsing errors for partial JSON chunks
          }
        }
      }
    }
  } catch (error) {
    throw new Error(
      `Error in fetchAIResponse: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  } finally {
    cleanupRequestSignal();
  }
}

function getFirstImageMediaType(images: Array<string | ImageInput>) {
  const firstImage = images[0];
  if (typeof firstImage === "object" && firstImage?.mediaType) {
    return firstImage.mediaType;
  }

  return "image/png";
}

function createRequestSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
) {
  if (!timeoutMs || timeoutMs <= 0) {
    return {
      signal: externalSignal,
      cleanup: () => {},
      timedOut: () => false,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternalSignal = () => controller.abort();
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternalSignal, {
      once: true,
    });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      window.clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    },
    timedOut: () => timedOut,
  };
}

function applyAIRequestOptionsToBody(
  bodyObj: any,
  provider: TYPE_PROVIDER,
  url: string,
  requestOptions: AIResponseRequestOptions | undefined
) {
  if (!requestOptions?.maxOutputTokens || !bodyObj || typeof bodyObj !== "object") {
    return;
  }

  const maxOutputTokens = Math.max(
    1,
    Math.floor(requestOptions.maxOutputTokens)
  );
  const hasOwn = (key: string) =>
    Object.prototype.hasOwnProperty.call(bodyObj, key);

  if (hasOwn("max_completion_tokens")) {
    bodyObj.max_completion_tokens = maxOutputTokens;
    return;
  }

  if (hasOwn("max_tokens")) {
    bodyObj.max_tokens = maxOutputTokens;
    return;
  }

  if (
    bodyObj.generationConfig &&
    typeof bodyObj.generationConfig === "object"
  ) {
    bodyObj.generationConfig.maxOutputTokens = maxOutputTokens;
    return;
  }

  switch (provider.id) {
    case "openai":
    case "groq":
      bodyObj.max_completion_tokens = maxOutputTokens;
      return;
    case "claude":
    case "gemini":
    case "grok":
    case "mistral":
    case "perplexity":
    case "openrouter":
    case "ollama":
    case "cohere":
      bodyObj.max_tokens = maxOutputTokens;
      return;
    default:
      break;
  }

  if (url.includes("/chat/completions")) {
    bodyObj.max_completion_tokens = maxOutputTokens;
  }
}
