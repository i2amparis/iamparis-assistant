| Config | Prompts | Turn s (median) | Turn s (p90) | Total s | Prompt tok/s | Same decision | Same top answer | Decided | Conflicts | Newly decided | No longer decided |
|---|---|---|---|---|---|---|---|---|---|---|---|
| base | 95 | 11.4 | 23.2 | 289 | 136 | 95/95 | 95/95 | 23 | 0 | 0 | 0 |
| threads8 | 95 | 22 | 45.9 | 558 | 70 | 95/95 | 95/95 | 23 | 0 | 0 | 0 |
| threads12 | 95 | 15.5 | 31.9 | 391 | 100 | 95/95 | 95/95 | 23 | 0 | 0 | 0 |
| q4_0 | 95 | 13.5 | 28.4 | 350 | 112 | 80/95 | 77/95 | 30 | 2 | 10 | 3 |
| qwen35-4b | 95 | 15.3 | 27.3 | 366 | 108 | 81/95 | 76/95 | 16 | 1 | 3 | 10 |
| qwen35-2b | 95 | 9.9 | 16.5 | 219 | 180 | 77/95 | 36/95 | 19 | 0 | 7 | 11 |
| granite-tiny | 95 | 9.1 | 16.3 | 225 | 175 | 71/95 | 44/95 | 29 | 0 | 15 | 9 |
| lfm2-8b-a1b | 95 | 8.6 | 14.2 | 215 | 185 | 65/95 | 52/95 | 39 | 2 | 22 | 6 |
| short | 95 | 10.6 | 14.8 | 233 | 146 | 93/95 | 91/95 | 25 | 0 | 2 | 0 |
| p8-current | 95 | 11.6 | 23.3 | 289 | 137 | 95/95 | 95/95 | 23 | 0 | 0 | 0 |
| p8-qfirst | 95 | 8.1 | 20.7 | 202 | 196 | 80/95 | 67/95 | 13 | 1 | 2 | 12 |
| p8-restate | 95 | 8.7 | 21.3 | 212 | 191 | 76/95 | 55/95 | 7 | 1 | 1 | 17 |
| p8-restate-short | 95 | 8.1 | 13.8 | 171 | 206 | 75/95 | 53/95 | 6 | 1 | 1 | 18 |

| Question (baseline) | Prompts | Share of time | Mean tokens | Mean s |
|---|---|---|---|---|
| Which variable does the user ask about? … | 10 | 36% | 1196 | 10.4 |
| Which IAMPARIS study fits the user's dat… | 19 | 18% | 383 | 2.8 |
| Which supported IAMPARIS task is the use… | 20 | 15% | 309 | 2.2 |
| Which region does the user ask about? Ch… | 12 | 7% | 266 | 1.8 |
| Which IAMPARIS page does the user ask fo… | 3 | 7% | 844 | 6.6 |
| Which scenario does the user name? Choos… | 12 | 6% | 241 | 1.5 |
| Which model does the user name? Choose n… | 16 | 6% | 180 | 1.0 |
| Which model does the user ask about?… | 1 | 2% | 719 | 5.7 |
| Which curated definition directly answer… | 1 | 2% | 704 | 5.3 |
| Which topic is the user most interested … | 1 | 1% | 400 | 2.9 |
