import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { stripeApiKeyMiddleware } from "x402-stripe";
import { extractParams } from "x402-ai";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const app = new Hono<{ Bindings: Env }>();

const SYSTEM_PROMPT = `You are a parameter extractor for a PDF text extraction service.
Extract the following from the user's message and return JSON:
- "url": the URL of the PDF file to extract text from (required)

Return ONLY valid JSON, no explanation. Example: {"url": "https://files.camelai.io/abc123?token=xyz&expires=999"}`;

app.use(stripeApiKeyMiddleware({ serviceName: "pdf-to-text" }));

app.use(async (c, next) => {
  if (c.get("skipX402")) return next();
  return cdpPaymentMiddleware(
    (env) => ({
      "POST /": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.01",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description:
          "Extract text from a PDF at a URL. Send {\"input\": \"extract text from https://...\"}. Upload files first at https://files.camelai.io to get a URL.",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            info: {
              input: {
                type: "http",
                method: "POST",
                bodyType: "json",
                body: {
                  input: {
                    type: "string",
                    description:
                      "Describe what PDF to extract text from. Provide a URL to the PDF. Upload local files to https://files.camelai.io first.",
                    required: true,
                  },
                },
              },
              output: { type: "json" },
            },
            schema: {
              properties: {
                input: {
                  properties: { method: { type: "string", enum: ["POST"] } },
                  required: ["method"],
                },
              },
            },
          },
        },
      },
    })
  )(c, next);
});

/**
 * Lightweight PDF text extractor that parses PDF binary for text content.
 * Looks for BT/ET text blocks and extracts Tj/TJ string operands.
 */
function extractTextFromPdfBinary(buffer: ArrayBuffer): { text: string; pages: number } {
  const bytes = new Uint8Array(buffer);
  const raw = new TextDecoder("latin1").decode(bytes);

  const pageMatches = raw.match(/\/Type\s*\/Page[^s]/g);
  const pages = pageMatches ? pageMatches.length : 1;

  const textParts: string[] = [];

  const btEtRegex = /BT\s([\s\S]*?)ET/g;
  let match;
  while ((match = btEtRegex.exec(raw)) !== null) {
    const block = match[1];

    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let tjMatch;
    while ((tjMatch = tjRegex.exec(block)) !== null) {
      textParts.push(decodePdfString(tjMatch[1]));
    }

    const tjArrayRegex = /\[(.*?)\]\s*TJ/g;
    let tjArrMatch;
    while ((tjArrMatch = tjArrayRegex.exec(block)) !== null) {
      const inner = tjArrMatch[1];
      const strRegex = /\(([^)]*)\)/g;
      let strMatch;
      while ((strMatch = strRegex.exec(inner)) !== null) {
        textParts.push(decodePdfString(strMatch[1]));
      }
    }
  }

  let text = textParts.join(" ").replace(/\s+/g, " ").trim();

  if (text.length < 50) {
    const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
    const streamParts: string[] = [];
    let sMatch;
    while ((sMatch = streamRegex.exec(raw)) !== null) {
      const content = sMatch[1];
      const pRegex = /\(([^)]{2,})\)/g;
      let pMatch;
      while ((pMatch = pRegex.exec(content)) !== null) {
        const decoded = decodePdfString(pMatch[1]);
        if (/[a-zA-Z]{2,}/.test(decoded)) {
          streamParts.push(decoded);
        }
      }
    }
    if (streamParts.join(" ").trim().length > text.length) {
      text = streamParts.join(" ").replace(/\s+/g, " ").trim();
    }
  }

  return { text, pages };
}

function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

app.post("/", async (c) => {
  const body = await c.req.json<{ input?: string }>();
  if (!body?.input) {
    return c.json({ error: "Missing 'input' field" }, 400);
  }

  const params = await extractParams(c.env.CF_GATEWAY_TOKEN, SYSTEM_PROMPT, body.input);
  const url = params.url as string;
  if (!url) {
    return c.json({ error: "Could not determine PDF URL. Upload your file to https://files.camelai.io first to get a URL." }, 400);
  }

  // Fetch the PDF
  const pdfRes = await fetch(url);
  if (!pdfRes.ok) {
    return c.json({ error: `Failed to fetch PDF: ${pdfRes.status} ${pdfRes.statusText}` }, 400);
  }

  const contentLength = parseInt(pdfRes.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_FILE_SIZE) {
    return c.json({ error: `PDF too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 413);
  }

  const buffer = await pdfRes.arrayBuffer();

  // Step 1: Try direct text extraction from PDF binary
  const { text: parsedText, pages } = extractTextFromPdfBinary(buffer);

  if (parsedText.length >= 50) {
    return c.json({
      text: parsedText,
      pages,
      method: "parsed",
      chars: parsedText.length,
    });
  }

  // Step 2: Fall back to Workers AI OCR for scanned/image PDFs
  try {
    const base64 = arrayBufferToBase64(buffer);

    const response = await c.env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract ALL text content from this document image. Return only the extracted text, nothing else. Preserve paragraph structure.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:application/pdf;base64,${base64}`,
              },
            },
          ],
        },
      ],
      max_tokens: 4096,
    });

    const ocrText =
      typeof response === "object" && "response" in response
        ? (response as { response: string }).response
        : String(response);

    const finalText = ocrText?.trim() || parsedText || "";

    return c.json({
      text: finalText,
      pages,
      method: finalText.length > parsedText.length ? "ocr" : "parsed",
      chars: finalText.length,
    });
  } catch {
    const fallbackText = parsedText || "";
    return c.json({
      text: fallbackText,
      pages,
      method: "parsed",
      chars: fallbackText.length,
      warning:
        fallbackText.length === 0
          ? "Could not extract text. The PDF may be encrypted or contain only images."
          : "OCR fallback failed; returning limited parsed text.",
    });
  }
});

app.get("/", (c) => {
  return c.json({
    service: "x402-pdf-to-text",
    description:
      "Extract text from PDFs via URL. Send POST / with {\"input\": \"extract text from https://...\"}. Upload local files to https://files.camelai.io first to get a URL.",
    price: "$0.01 per request (Base mainnet)",
    maxFileSize: "10MB",
  });
});

export default app;
