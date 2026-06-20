import { GoogleGenerativeAI } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

export async function embedText(text: string): Promise<number[]> {
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' })
  const result = await model.embedContent({
    content: { 
      role: 'user', 
      parts: [{ text }] 
    },
    outputDimensionality: 768,
  } as any)
  return result.embedding.values
}

// Markdown-Aware Smart Chunking
export function chunkText(text: string, maxWords = 500): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentWordCount = 0;

  for (const line of lines) {
    const isHeader = /^#{1,6}\s+/.test(line.trim());
    const lineWordCount = line.split(/\s+/).filter(Boolean).length;

    if ((isHeader || (currentWordCount + lineWordCount > maxWords)) && currentChunk.length > 0) {
      const chunkStr = currentChunk.join('\n').trim();
      if (chunkStr.length > 50) {
        chunks.push(chunkStr);
      }
      currentChunk = [];
      currentWordCount = 0;
    }

    currentChunk.push(line);
    currentWordCount += lineWordCount;
  }

  if (currentChunk.length > 0) {
    const chunkStr = currentChunk.join('\n').trim();
    if (chunkStr.length > 50) {
      chunks.push(chunkStr);
    }
  }

  return chunks;
}
