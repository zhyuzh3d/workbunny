# workbunny memory paraphrase recall check

Run: `node tools/eval-memory-recall.js` at HEAD `c86974d1e626454d48d0177a4ad94db88b27be14`. The runner compiled the existing SQLite helper and exercised the real encrypted `MemoryService` against a temporary database, then removed that database. It used 27 public synthetic cases dated 2011–2025: 15 Chinese and 12 English, covering facts, preferences, promises, same-name entities, and time-qualified conflicts. It made no model calls, used no real Keychain, and left pinned memories out of the semantic-hit score.

## Results

| Set | Cases | Recall@5 | Context hit |
| --- | ---: | ---: | ---: |
| Overall | 27 | 19/27 (70.4%) | 20/27 (74.1%) |
| Chinese | 15 | 10/15 (66.7%) | 11/15 (73.3%) |
| English | 12 | 9/12 (75.0%) | 9/12 (75.0%) |
| Facts | 7 | 3/7 (42.9%) | 3/7 (42.9%) |
| Preferences | 7 | 4/7 (57.1%) | 5/7 (71.4%) |
| Promises | 7 | 6/7 (85.7%) | 6/7 (85.7%) |
| Same-name disambiguation | 2 | 2/2 | 2/2 |
| Time-qualified conflicts | 4 | 4/4 | 4/4 |

`Recall@5` means the target memory appeared in the first five lexical search results. `Context hit` means its ID appeared in `context().sourceIds`, so unrelated pinned injection cannot count as success. Context searches a wider candidate pool than top five, which explains one case that missed Recall@5 but did enter context.

The main failure cluster is semantic paraphrase with little word overlap. Four of seven fact cases failed both checks; examples include asking for the city where field recordings are stored and the location of a family recipe when the stored memory used different words. Several preference queries either returned no result or ranked unrelated preference records; a location query ranked a Jordan jersey record for a museum-archive question. This confirms that the current HMAC token search is useful for overlapping terms and explicit dates, but does not provide reliable broad semantic recall. These results describe this small synthetic set only.

Machine-readable metrics and failure IDs are in [workbunny-memory-recall-2026-10-25.json](workbunny-memory-recall-2026-10-25.json). The complete synthetic prompts are in [eval-memory-recall.js](../tools/eval-memory-recall.js).

## macOS NaturalLanguage availability

The diagnostic ran on macOS 26.5.1 arm64 with the macOS 26 SDK and Swift 6.3.2. `NLEmbedding.sentenceEmbedding(for:)` returned vectors locally for both test languages: Simplified Chinese, 640 dimensions, revision 1; English, 512 dimensions, revision 1. This verifies those two sentence-vector APIs work on this machine. Because dimensions differ, the returned Chinese and English vectors cannot be compared directly in one shared cosine space without an additional mapping or model.

`NLContextualEmbedding` discovery found a 512-dimensional Chinese/Japanese/Korean model (revision 1, 256-token sequence limit) and a separate 512-dimensional English/Latin-language model (revision 1, 256-token limit). The English model reported local assets available; the Chinese model reported assets unavailable. The diagnostic did not call `requestAssets`, which Apple documents as an over-the-air download request, and did not load the contextual models. So the contextual Chinese model is not currently usable offline on this installation; English assets appear installed, but model loading/inference was deliberately not tested.

Apple documents sentence embeddings as available only when a language model exists, and contextual embeddings expose supported languages, dimensions, local-asset status, and download management in the API: [NLEmbedding sentence embedding](https://developer.apple.com/documentation/naturallanguage/nlembedding/sentenceembedding%28for%3A%29), [NLContextualEmbedding languages and model properties](https://developer.apple.com/documentation/naturallanguage/nlcontextualembedding/languages), and [asset availability](https://developer.apple.com/documentation/naturallanguage/nlcontextualembedding/hasavailableassets). The local SDK headers confirm the same APIs and macOS availability. The runtime probe only queried model metadata and generated the two sentence vectors; it made no network request.
