# Local sentence-vector and LSH prototype

Run: `node tools/eval-memory-embedding.js --distractors=1000`. This reused the same 27 synthetic paraphrase cases from the lexical eval, generated local `NLEmbedding.sentenceEmbedding` vectors for 27 memory texts, 27 queries, and 1,000 extra synthetic notes, then ranked within each language separately. No cross-language cosine, user data, model service, or download was involved. Total corpus was 1,027 memories; the measured run took 12.1 seconds.

The vector producer is [natural-language-vectors.swift](../tools/natural-language-vectors.swift). It uses only `NLEmbedding.sentenceEmbedding(for:)` and `vector(for:)`; it does not invoke contextual embedding asset requests. The full machine report is [workbunny-memory-embedding-2026-10-25.json](workbunny-memory-embedding-2026-10-25.json).

## Retrieval results

| Method | Recall@5 | Top 1 |
| --- | ---: | ---: |
| Existing lexical search, 27-case set | 19/27 (70.4%) | not recorded |
| Exact sentence cosine, only 27 target memories | 22/27 (81.5%) | 9/27 (33.3%) |
| Exact sentence cosine, with 1,000 distractors | 21/27 (77.8%) | 9/27 (33.3%) |
| LSH candidates then cosine rerank, 1,000 distractors | 5/27 (18.5%) | 4/27 (14.8%) |

Exact cosine by language was 11/15 Chinese (73.3%) and 11/12 English (91.7%) in the 27-target-only set. With distractors it was 11/15 Chinese and 10/12 English. By category, exact target-only Recall@5 was 4/7 for facts, 6/7 for preferences, 6/7 for promises, 2/2 for same-name cases, and 4/4 for time-qualified conflicts. Top 1 across the full case set was only 9/27, so high top-five recall did not consistently identify the right fact first.

The LSH simulation used 10 random-hyperplane tables with 10 bits each, fixed independent seeds per language, and queried each exact bucket plus its ten one-bit neighbors (110 bucket lookups). It ordered matches by shared buckets, kept 50, then reranked by exact cosine. The target reached the top-50 candidate set in only 6/27 queries: 3/15 Chinese and 3/12 English. LSH rerank Recall@5 remained 5/27. Chinese bucket signatures collapsed to just 4–12 distinct codes per table and every Chinese query matched all 515 same-language records within the one-bit probes; this yielded no candidate reduction. English queries matched a mean 108 of 512 records, but targets were still present in only 3/12 candidate sets.

Hubness was also high: among 15 Chinese queries, ten stored vectors appeared in at least three top-five lists; the most frequent appeared in 14. English had nine such vectors among 12 queries. Same-name and conflict checks show exact cosine sometimes distinguished the intended item, but LSH often removed it before reranking. Examples with full ranks and scores are in the JSON report.

For the focused entity cases, exact cosine on the 27 target memories placed both same-name answers in top five but selected the right one first only once. Time-qualified conflicts were 4/4 in top five but 2/4 top one; after adding distractors, one conflict fell below top five. LSH retained one of two same-name targets and one of four conflict targets in the reranked top five.

## Storage estimate and decision

Assuming float32 vectors encrypted as AES-GCM with a 12-byte nonce and 16-byte tag, then stored as base64 text, each vector is about 3,452 characters for Chinese (640 dimensions) and 2,768 for English (512 dimensions). The binary encrypted payloads are 2,588 and 2,076 bytes, respectively. Ten bucket identifiers at about 22 characters each add roughly 220 token characters per memory, before SQLite index overhead.

The local models show useful exact-vector recall on these synthetic paraphrases, but top-one accuracy is modest and the tested LSH candidate scheme is unsuitable for production indexing: candidate quality and reduction were poor, especially for Chinese. This small set is not evidence of user-memory quality at scale. Do not add the LSH index based on this result. A larger, blinded, locally reviewed quality set would be needed before deciding whether exact vector fallback merits storage cost.

Apple describes sentence embeddings as available by language when a model exists, and provides vector lookup through NaturalLanguage: [sentenceEmbedding(for:)](https://developer.apple.com/documentation/naturallanguage/nlembedding/sentenceembedding%28for%3A%29). The previous availability probe found separate Chinese and English dimensions, so this prototype keeps their search spaces isolated.
