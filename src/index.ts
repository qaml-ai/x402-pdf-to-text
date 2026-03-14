import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { openapiFromMiddleware } from "x402-openapi";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const app = new Hono<{ Bindings: Env }>();

const ROUTES = {
  "POST /": {
    accepts: [{ scheme: "exact", price: "$0.01", network: "eip155:8453", payTo: "0x0" as `0x${string}` }],
    description: "Extract text from a PDF file. Upload as multipart/form-data with a 'file' field.",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "multipart",
            body: {
              file: { type: "file", description: "PDF file to extract text from (max 10MB)", required: true },
              input: { type: "string", description: "Optional text instructions (unused, file is primary input)", required: false },
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
};

app.use(
  cdpPaymentMiddleware((env) => ({
    "POST /": { ...ROUTES["POST /"], accepts: [{ ...ROUTES["POST /"].accepts[0], payTo: env.SERVER_ADDRESS as `0x${string}` }] },
  }))
);

/**
 * Lightweight PDF text extractor that parses PDF binary for text content.
 * Looks for BT/ET text blocks and extracts Tj/TJ string operands.
 */
function extractTextFromPdfBinary(buffer: ArrayBuffer): { text: string; pages: number } {
  const bytes = new Uint8Array(buffer);
  const raw = new TextDecoder("latin1").decode(bytes);

  // Count pages
  const pageMatches = raw.match(/\/Type\s*\/Page[^s]/g);
  const pages = pageMatches ? pageMatches.length : 1;

  const textParts: string[] = [];

  // Strategy 1: Extract text from BT...ET blocks using Tj and TJ operators
  const btEtRegex = /BT\s([\s\S]*?)ET/g;
  let match;
  while ((match = btEtRegex.exec(raw)) !== null) {
    const block = match[1];

    // Match Tj operator: (string) Tj
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let tjMatch;
    while ((tjMatch = tjRegex.exec(block)) !== null) {
      textParts.push(decodePdfString(tjMatch[1]));
    }

    // Match TJ operator: [(string) num (string) ...] TJ
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

  // Join with spaces, collapse whitespace
  let text = textParts.join(" ").replace(/\s+/g, " ").trim();

  // Strategy 2: If BT/ET extraction yielded little, try extracting stream content
  if (text.length < 50) {
    const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
    const streamParts: string[] = [];
    let sMatch;
    while ((sMatch = streamRegex.exec(raw)) !== null) {
      const content = sMatch[1];
      // Extract any parenthesized strings from streams
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

/** Decode PDF escape sequences in a string operand */
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

/** Convert ArrayBuffer to base64 string */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

app.post("/", async (c) => {
  let body: FormData;
  try {
    body = await c.req.formData();
  } catch {
    return c.json({ error: "Request must be multipart/form-data" }, 400);
  }

  const file = body.get("file");
  if (!file || !(file instanceof File)) {
    return c.json({ error: "Missing 'file' field (must be a PDF file)" }, 400);
  }

  if (file.size > MAX_FILE_SIZE) {
    return c.json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 413);
  }

  if (file.type && file.type !== "application/pdf" && !file.name?.endsWith(".pdf")) {
    return c.json({ error: "File must be a PDF" }, 400);
  }

  const buffer = await file.arrayBuffer();

  // Step 1: Try direct text extraction from PDF binary
  const { text: parsedText, pages } = extractTextFromPdfBinary(buffer);

  // If we got meaningful text, return it
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
    // Convert PDF to base64 for the vision model
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

    const ocrText = typeof response === "object" && "response" in response
      ? (response as { response: string }).response
      : String(response);

    const finalText = ocrText?.trim() || parsedText || "";

    return c.json({
      text: finalText,
      pages,
      method: finalText.length > parsedText.length ? "ocr" : "parsed",
      chars: finalText.length,
    });
  } catch (ocrError) {
    // If OCR fails, return whatever we parsed (even if minimal)
    const fallbackText = parsedText || "";
    return c.json({
      text: fallbackText,
      pages,
      method: "parsed",
      chars: fallbackText.length,
      warning: fallbackText.length === 0
        ? "Could not extract text. The PDF may be encrypted or contain only images."
        : "OCR fallback failed; returning limited parsed text.",
    });
  }
});

app.get("/.well-known/openapi.json", openapiFromMiddleware("x402 PDF to Text", "pdf.camelai.io", ROUTES));

app.get("/", (c) => {
  return c.json({
    service: "x402-pdf-to-text",
    description: 'Extract text from PDF files. Send POST / with {"input": "extract text"} as multipart/form-data with a file field',
    price: "$0.01 per request (Base mainnet)",
    maxFileSize: "10MB",
  });
});

export default app;
