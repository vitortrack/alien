const ENGLISH = new Set(
  `the and is are was were be been of to with this that these those from which will would should could can now let let's i i'll i'm we we'll need needs
   check checking then first next found fix fixed fixing run running also but not it its it's there here all both so because into only just
   picture look looks looking read reading file files tests verify verified confirm done let me okay ok what where why how when after before
   still already something nothing anything about update updated change changed changes make sure see seems issue issues root cause`
    .split(/\s+/)
    .filter(Boolean),
);

const PORTUGUESE_MARKERS = /\b(que|não|para|com|uma?|os|as|do|da|dos|das|em|no|na|é|está|são|foi|pelo|pela|isso|esse|essa)\b/i;

function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\S*[/\\._:()[\]{}=<>#@$]\S*/g, ' ');
}

export type LanguageReport = { words: number; englishWords: number; rate: number; samples: string[] };

export function englishInProse(texts: string[]): LanguageReport {
  let words = 0;
  let englishWords = 0;
  const samples: string[] = [];
  for (const text of texts) {
    for (const sentence of prose(text).split(/[.!?\n]+/)) {
      const tokens = sentence.toLowerCase().match(/[a-zà-ÿ']+/g) ?? [];
      if (!tokens.length) continue;
      const hits = tokens.filter((t) => ENGLISH.has(t));
      words += tokens.length;
      englishWords += hits.length;
      const mostlyEnglish = hits.length >= 2 && !PORTUGUESE_MARKERS.test(sentence);
      if ((hits.length >= 2 || mostlyEnglish) && samples.length < 5) samples.push(sentence.trim().slice(0, 120));
    }
  }
  return { words, englishWords, rate: words ? englishWords / words : 0, samples };
}
