/**
 * musicXmlCatalogs.ts — Public Domain / CC0 MusicXML (.mxl) catalogs and external discovery links
 * for MuseTrainer Library (https://musetrainer.github.io/library) and
 * OpenScore Lieder Corpus (https://fourscoreandmore.org/openscore/lieder/).
 */

import type { PublicMidiSearchResult } from "./publicMidiSearch";

export interface MuseTrainerRawEntry {
  readonly title: string;
  readonly artist: string | null;
  readonly file: string;
}

/**
 * Complete 69-piece Public Domain piano MusicXML (.mxl) catalog from
 * https://musetrainer.github.io/library (github.com/musetrainer/library).
 */
export const MUSETRAINER_SCORES: readonly MuseTrainerRawEntry[] = [
  { title: "Air on the G String (Piano Arrangement)", artist: "J. S. Bach", file: "J._S._Bach_-_Air_on_the_G_String_Piano_arrangement.mxl" },
  { title: "Arabesque No. 1 in E Major, L. 66", artist: "Claude Debussy", file: "Arabesque_L._66_No._1_in_E_Major.mxl" },
  { title: "Ave Maria, D. 839 (Solo Piano)", artist: "Franz Schubert", file: "Ave_Maria_D839_-_Schubert_-_Solo_Piano_Arrg..mxl" },
  { title: "Minuet in G Major, BWV Anh. 114", artist: "J. S. Bach / Christian Petzold", file: "Bach_Minuet_in_G_Major_BWV_Anh._114.mxl" },
  { title: "Toccata and Fugue in D Minor (Piano Solo)", artist: "J. S. Bach", file: "Bach_Toccata_and_Fugue_in_D_Minor_Piano_solo.mxl" },
  { title: "Ballade No. 1 in G Minor, Op. 23", artist: "Frédéric Chopin", file: "Chopin_-_Ballade_no._1_in_G_minor_Op._23.mxl" },
  { title: "Symphony No. 5, 1st Movement (Piano Solo)", artist: "Ludwig van Beethoven", file: "Beethoven_Symphony_No._5_1st_movement_Piano_solo.mxl" },
  { title: "Bella Ciao (La Casa de Papel)", artist: "Traditional Italian", file: "Bella_Ciao_-_La_Casa_de_Papel.mxl" },
  { title: "Bella Ciao (Piano Solo)", artist: "Traditional Italian", file: "Bella_Ciao.mxl" },
  { title: "Canon in D", artist: "Johann Pachelbel", file: "Canon_in_D.mxl" },
  { title: "Canon in D (Arrangement 2)", artist: "Johann Pachelbel", file: "Canon_in_D_3.mxl" },
  { title: "Canon in D (Easy Piano)", artist: "Johann Pachelbel", file: "Canon_in_D_easy.mxl" },
  { title: "Carol of the Bells (Easy Piano)", artist: "Mykola Leontovych", file: "Carol_of_the_Bells_easy_piano.mxl" },
  { title: "Carol of the Bells", artist: "Mykola Leontovych", file: "Carol_of_the_Bells.mxl" },
  { title: "Nocturne in B-flat Minor, Op. 9 No. 1", artist: "Frédéric Chopin", file: "Chopin_-_Nocturne_Op._9_No._1.mxl" },
  { title: "Clair de Lune", artist: "Claude Debussy", file: "Clair_de_Lune__Debussy.mxl" },
  { title: "Clair de Lune (Edition 2)", artist: "Claude Debussy", file: "Clair_de_lune_-_Claude_Debussy.mxl" },
  { title: "Danse Villageoise", artist: "Ludwig van Beethoven", file: "DANSE_VILLAGEOISE_Beethoven.mxl" },
  { title: "Dance of the Sugar Plum Fairy", artist: "Pyotr Ilyich Tchaikovsky", file: "Dance_of_the_sugar_plum_fairy.mxl" },
  { title: "Gymnopédie No. 1", artist: "Erik Satie", file: "Erik_Satie_-_Gymnopedie_No.1.mxl" },
  { title: "Flight of the Bumblebee", artist: "Nikolai Rimsky-Korsakov", file: "Flight_of_the_Bumblebee.mxl" },
  { title: "Für Elise (Easy Piano)", artist: "Ludwig van Beethoven", file: "Fur_Elise_Easy_Piano.mxl" },
  { title: "Für Elise (Beginner Piano)", artist: "Ludwig van Beethoven", file: "Fur_Elise_-_Beethoven_-_for_beginner_piano.mxl" },
  { title: "Für Elise (Fingered)", artist: "Ludwig van Beethoven", file: "Fur_Elise_fingered.mxl" },
  { title: "Für Elise in A Minor", artist: "Ludwig van Beethoven", file: "Fur_Elise.mxl" },
  { title: "G Minor Bach (Original)", artist: "J. S. Bach / Luo Ni", file: "G_Minor_Bach_Original.mxl" },
  { title: "G Minor Bach", artist: "J. S. Bach / Luo Ni", file: "G_Minor_Bach.mxl" },
  { title: "Gnossienne No. 1", artist: "Erik Satie", file: "Gnossienne_No._1.mxl" },
  { title: "Greensleeves (Easy Piano)", artist: "Traditional English", file: "Greensleeves_for_Piano_easy_and_beautiful.mxl" },
  { title: "Gymnopédie No. 1 (Edition 2)", artist: "Erik Satie", file: "Gymnopdie_No._1__Satie.mxl" },
  { title: "Happy Birthday To You (Piano)", artist: "Traditional", file: "Happy_Birthday_To_You_Piano.mxl" },
  { title: "Happy Birthday To You in C Major", artist: "Traditional", file: "Happy_Birthday_To_You_C_Major.mxl" },
  { title: "Hungarian Dance No. 5 in G Minor", artist: "Johannes Brahms", file: "Hungarian_Dance_No_5_in_G_Minor.mxl" },
  { title: "Hungarian Sonata", artist: "Paul de Senneville / Richard Clayderman", file: "Hungarian_Sonata.mxl" },
  { title: "La Campanella (Grandes Études de Paganini No. 3)", artist: "Franz Liszt", file: "La_Campanella_-_Grandes_Etudes_de_Paganini_No._3_-_Franz_Liszt.mxl" },
  { title: "Lacrimosa (Requiem)", artist: "W. A. Mozart", file: "Lacrimosa_-_Requiem.mxl" },
  { title: "Liebestraum No. 3 in A-flat Major", artist: "Franz Liszt", file: "Liebestraum_No._3_in_A_Major.mxl" },
  { title: "Spring Waltz (Mariage d'Amour)", artist: "Paul de Senneville", file: "Chopin_-_Spring_Waltz.mxl" },
  { title: "Maple Leaf Rag", artist: "Scott Joplin", file: "Maple_Leaf_Rag_Scott_Joplin.mxl" },
  { title: "Mariage d'Amour", artist: "Paul de Senneville", file: "Mariage_dAmour.mxl" },
  { title: "Minuet in G Major", artist: "J. S. Bach", file: "Minuet_in_G_Major_Bach.mxl" },
  { title: "Moonlight Sonata, 3rd Movement (Presto Agitato)", artist: "Ludwig van Beethoven", file: "moonlight_sonata_3rd_movement.mxl" },
  { title: "Piano Sonata No. 16 in C Major, K. 545 — Allegro", artist: "W. A. Mozart", file: "Mozart_-_Piano_Sonata_No._16_-_Allegro.mxl" },
  { title: "Nocturne in E-flat Major, Op. 9 No. 2 (Easy)", artist: "Frédéric Chopin", file: "Nocturne_in_E-flat_Major_Op._9_No._2_Easy.mxl" },
  { title: "Nocturne in E-flat Major, Op. 9 No. 2", artist: "Frédéric Chopin", file: "Chopin_-_Nocturne_Op_9_No_2_E_Flat_Major.mxl" },
  { title: "Nocturne No. 20 in C-sharp Minor, Op. posth.", artist: "Frédéric Chopin", file: "Nocturne_No._20_in_C_Minor.mxl" },
  { title: "Nocturne in C-sharp Minor", artist: "Frédéric Chopin", file: "Nocturne_in_C_sharp_Minor.mxl" },
  { title: "Ode to Joy (Easy Variation)", artist: "Ludwig van Beethoven", file: "Ode_to_Joy_Easy_variation.mxl" },
  { title: "Passacaglia in G Minor", artist: "G. F. Handel / Halvorsen", file: "Passacaglia.mxl" },
  { title: "Passacaglia (Arrangement 2)", artist: "G. F. Handel / Halvorsen", file: "Passacaglia2.mxl" },
  { title: "Piano Sonata No. 11, K. 331 — Rondo alla Turca", artist: "W. A. Mozart", file: "Piano_Sonata_No._11_K._331_3rd_Movement_Rondo_alla_Turca.mxl" },
  { title: "Prelude No. 1 in C Major, BWV 846 (WTC Book I)", artist: "J. S. Bach", file: "Prelude_I_in_C_major_BWV_846_-_Well_Tempered_Clavier_First_Book.mxl" },
  { title: "Prelude No. 2 in C Minor, BWV 847 (WTC Book I)", artist: "J. S. Bach", file: "Prelude_No._2_BWV_847_in_C_Minor.mxl" },
  { title: "Prelude in E Minor, Op. 28 No. 4", artist: "Frédéric Chopin", file: "Prlude_Opus_28_No._4_in_E_Minor__Chopin.mxl" },
  { title: "Prelude in E Minor, Op. 28 No. 4 (Edition 2)", artist: "Frédéric Chopin", file: "Prlude_No._4_in_E_Minor_Op._28_-_Frdric_Chopin.mxl" },
  { title: "Sonata No. 16 in C Major, K. 545 (1st Movement)", artist: "W. A. Mozart", file: "Sonata_No._16_1st_Movement_K._545.mxl" },
  { title: "Moonlight Sonata No. 14, Op. 27 No. 2 (1st Movement)", artist: "Ludwig van Beethoven", file: "Sonate_No._14_Moonlight_1st_Movement.mxl" },
  { title: "Moonlight Sonata No. 14, Op. 27 No. 2 (3rd Movement)", artist: "Ludwig van Beethoven", file: "Sonate_No._14_Moonlight_3rd_Movement.mxl" },
  { title: "Sonata No. 8 'Pathétique', Op. 13 (2nd Movement)", artist: "Ludwig van Beethoven", file: "Sonate_No._8_Pathetique_2nd_Movement.mxl" },
  { title: "Schubert Serenade (Ständchen, arr. Liszt)", artist: "Franz Schubert / Franz Liszt", file: "Schubert_Serenade_-_Standchen_-_By_Lizst.mxl" },
  { title: "Spring Waltz (Edition 2)", artist: "Paul de Senneville", file: "Spring_Waltz_Mariage_dAmour_-_Chopin.mxl" },
  { title: "Swan Lake Theme", artist: "Pyotr Ilyich Tchaikovsky", file: "Swan_Lake.mxl" },
  { title: "The Entertainer", artist: "Scott Joplin", file: "The_Entertainer_-_Scott_Joplin.mxl" },
  { title: "The Entertainer (1902 Original)", artist: "Scott Joplin", file: "The_Entertainer_-_Scott_Joplin_-_1902.mxl" },
  { title: "12 Variations on 'Twinkle, Twinkle, Little Star', K. 265", artist: "W. A. Mozart", file: "12_Variations_of_Twinkle_Twinkle_Little_Star.mxl" },
  { title: "Turkish March (Rondo alla Turca, Fingered)", artist: "W. A. Mozart", file: "WA_Mozart_Marche_Turque_Turkish_March_fingered.mxl" },
  { title: "Waltz in C-sharp Minor, Op. 64 No. 2", artist: "Frédéric Chopin", file: "Waltz_Opus_64_No._2_in_C_Minor.mxl" },
  { title: "Waltz in A Minor, B. 150", artist: "Frédéric Chopin", file: "Waltz_in_A_MinorChopin.mxl" },
  { title: "Waltz of the Flowers (The Nutcracker)", artist: "Pyotr Ilyich Tchaikovsky", file: "Waltz_of_the_Flowers.mxl" },
];

/**
 * Curated fallback paths from OpenScore Lieder Corpus (CC0 1.0 Public Domain,
 * https://github.com/OpenScore/Lieder / https://fourscoreandmore.org/openscore/lieder/).
 */
export const OPENSCORE_CURATED_PATHS: readonly string[] = [
  "scores/Schubert,_Franz/Winterreise,_D.911/01_-_Gute_Nacht/lc5001501.mxl",
  "scores/Schubert,_Franz/Winterreise,_D.911/05_-_Der_Lindenbaum/lc5001505.mxl",
  "scores/Schubert,_Franz/Schwanengesang,_D.957/04_-_Ständchen/lc4982909.mxl",
  "scores/Schubert,_Franz/Die_schöne_Müllerin,_D.795/01_-_Das_Wandern/lc4976654.mxl",
  "scores/Schumann,_Robert/Dichterliebe,_Op.48/01_-_Im_wunderschönen_Monat_Mai/lc4996959.mxl",
  "scores/Schumann,_Robert/Myrthen,_Op.25/01_-_Widmung/lc4996993.mxl",
  "scores/Schumann,_Clara/6_Lieder,_Op.13/1_Ich_stand_in_dunklen_Träumen/lc4946495.mxl",
  "scores/Beethoven,_Ludwig_van/6_Lieder,_Op.48/1_Bitten/lc5115311.mxl",
  "scores/Beethoven,_Ludwig_van/6_Lieder,_Op.48/4_Die_Ehre_Gottes_aus_der_Natur/lc5121134.mxl",
  "scores/Beethoven,_Ludwig_van/8_Lieder,_Op.52/3_Das_Liedchen_von_der_Ruhe/lc6491353.mxl",
  "scores/Beethoven,_Ludwig_van/8_Lieder,_Op.52/4_Mailied/lc6491377.mxl",
  "scores/Brahms,_Johannes/5_Lieder,_Op.49/4_Wiegenlied/lc5667969.mxl",
  "scores/Brahms,_Johannes/4_Songs,_Op.43/1_Von_ewiger_Liebe/lc5153813.mxl",
  "scores/Brahms,_Johannes/4_Songs,_Op.43/2_Die_Mainacht/lc5153947.mxl",
  "scores/Brahms,_Johannes/5_Lieder,_Op.47/1_Botschaft/lc5656522.mxl",
  "scores/Mozart,_Wolfgang_Amadeus/_/Abendempfindung,_K.523/lc5057662.mxl",
  "scores/Mozart,_Wolfgang_Amadeus/_/Das_Veilchen,_K.476/lc5057654.mxl",
  "scores/Mendelssohn,_Felix/6_Gesänge,_Op.34/2_Auf_Flügeln_des_Gesanges/lc5006435.mxl",
  "scores/Hensel,_Fanny/6_Lieder,_Op.1/1_Schwanenlied/lc4974983.mxl",
  "scores/Liszt,_Franz/_/Oh!_quand_je_dors,_S.282/lc5057688.mxl",
  "scores/Debussy,_Claude/_/Beau_Soir/lc5057614.mxl",
  "scores/Fauré,_Gabriel/3_Mélodies,_Op.7/1_Après_un_rêve/lc5057630.mxl",
  "scores/Grieg,_Edvard/6_Songs,_Op.48/6_Ein_Traum/lc5057644.mxl",
  "scores/Arne,_Thomas/_/Rule,_Britannia!/lc29233346.mxl",
];

export function toMuseTrainerSearchResult(entry: MuseTrainerRawEntry): PublicMidiSearchResult {
  const url = `https://musetrainer.github.io/library/scores/${entry.file}`;
  return {
    id: `musetrainer:${entry.file}`,
    dedupeKey: url.toLowerCase(),
    provider: "musetrainer",
    source: "MuseTrainer",
    format: "mxl",
    title: entry.title,
    artist: entry.artist,
    license: "Public Domain",
    licenseUrl: "https://musetrainer.github.io/library",
    attribution: entry.artist ? `${entry.artist} · MuseTrainer Piano MXL` : "MuseTrainer Public Domain Piano MXL",
    url,
    sourceUrl: "https://musetrainer.github.io/library",
  };
}

export function parseOpenScorePath(repoPath: string): PublicMidiSearchResult | null {
  if (!repoPath.startsWith("scores/") || !repoPath.endsWith(".mxl") || repoPath.includes("..")) {
    return null;
  }
  const parts = repoPath.split("/");
  if (parts.length < 5) return null;
  const rawComposer = parts[1] ?? "";
  const rawSet = parts[2] ?? "";
  const rawSong = parts[3] ?? "";

  const composerParts = rawComposer.split(",_");
  const artist =
    composerParts.length === 2
      ? `${composerParts[1]!.replace(/_/g, " ")} ${composerParts[0]!.replace(/_/g, " ")}`.trim()
      : rawComposer.replace(/_/g, " ").trim();

  const songTitle = rawSong.replace(/_/g, " ").trim();
  const setTitle = rawSet !== "_" ? rawSet.replace(/_/g, " ").trim() : "";
  const title = setTitle ? `${songTitle} (${setTitle})` : songTitle;

  const encodedSegments = parts.map((seg) => encodeURIComponent(seg)).join("/");
  const url = `https://raw.githubusercontent.com/OpenScore/Lieder/main/${encodedSegments}`;

  return {
    id: `openscore:${repoPath}`,
    dedupeKey: url.toLowerCase(),
    provider: "openscore",
    source: "OpenScore Lieder",
    format: "mxl",
    title: title || "Untitled OpenScore Lied",
    artist: artist || null,
    license: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    attribution: artist ? `${artist} · OpenScore CC0` : "OpenScore Lieder Corpus (CC0)",
    url,
    sourceUrl: "https://fourscoreandmore.org/openscore/lieder/",
  };
}

function matchesTerms(haystack: string, query: string): boolean {
  const normalizedHaystack = haystack
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const terms = query
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return terms.length > 0 && terms.every((term) => normalizedHaystack.includes(term));
}

export function searchMuseTrainerCatalog(query: string, limit = 12): PublicMidiSearchResult[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return MUSETRAINER_SCORES.slice(0, limit).map(toMuseTrainerSearchResult);
  }
  const matches: PublicMidiSearchResult[] = [];
  for (const entry of MUSETRAINER_SCORES) {
    const searchable = `${entry.title} ${entry.artist ?? ""} ${entry.file.replace(/_/g, " ")}`;
    if (matchesTerms(searchable, trimmed)) {
      matches.push(toMuseTrainerSearchResult(entry));
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

let cachedOpenScorePaths: string[] | null = null;

export async function searchOpenScoreLieder(
  query: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  limit = 10,
): Promise<PublicMidiSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  let paths = cachedOpenScorePaths;
  if (!paths) {
    try {
      const response = await fetchImpl(
        "https://api.github.com/repos/OpenScore/Lieder/git/trees/HEAD?recursive=1",
        { signal },
      );
      if (response.ok) {
        const data = (await response.json()) as { tree?: Array<{ path?: string }> };
        if (Array.isArray(data.tree)) {
          paths = data.tree
            .map((item) => (typeof item.path === "string" ? item.path : ""))
            .filter((p) => p.startsWith("scores/") && p.endsWith(".mxl"));
          if (paths.length > 0) {
            cachedOpenScorePaths = paths;
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
    }
  }

  const candidatePaths = paths && paths.length > 0 ? paths : OPENSCORE_CURATED_PATHS;
  const results: PublicMidiSearchResult[] = [];
  for (const path of candidatePaths) {
    const searchable = path.replace(/[/_,-]+/g, " ");
    if (!matchesTerms(searchable, trimmed)) continue;
    const parsed = parseOpenScorePath(path);
    if (parsed) {
      results.push(parsed);
      if (results.length >= limit) break;
    }
  }
  return results;
}

export interface ExternalMusicXmlPortalLink {
  readonly id: string;
  readonly label: string;
  readonly badge: string;
  readonly url: string;
  readonly description: string;
}

/**
 * Builds 1-click external web discovery links for MusicXML repositories & search engines
 * using the current search query.
 */
export function buildExternalMusicXmlLinks(query: string): ExternalMusicXmlPortalLink[] {
  const q = query.trim() || "piano";
  const encodedQuery = encodeURIComponent(q);
  const githubFormula = encodeURIComponent(`${q} extension:mxl OR extension:musicxml piano`);
  const googleFormula = encodeURIComponent(`${q} filetype:mxl OR filetype:musicxml "piano"`);

  return [
    {
      id: "musetrainer",
      label: "MuseTrainer Library",
      badge: "Public Domain MXL",
      url: "https://musetrainer.github.io/library",
      description: "Public domain MusicXML library with popular songs formatted for piano.",
    },
    {
      id: "pianoml",
      label: "PianoML Library",
      badge: "Piano MusicXML",
      url: "https://www.pianoml.org/library",
      description: "Browse thousands of piano MusicXML scores by genre, composer, and difficulty.",
    },
    {
      id: "openscore",
      label: "OpenScore Lieder",
      badge: "CC0 Classical",
      url: "https://fourscoreandmore.org/openscore/lieder/",
      description: "1,300+ 19th-century classical art songs for voice and piano in CC0 MusicXML.",
    },
    {
      id: "musescore",
      label: `MuseScore (“${q}” PD Piano)`,
      badge: "Free Account MXL",
      url: `https://musescore.com/sheetmusic?text=${encodedQuery}&instrumentation=114&license=to_use_commercially,to_modify_commercially`,
      description:
        "Filtered to Public Domain & Piano Solo. Log into a free account, decline PRO trial pop-ups, and choose Download → MXL / MusicXML on non-official scores.",
    },
    {
      id: "github-mxl",
      label: `GitHub Search (“${q}” .mxl)`,
      badge: "Code Search",
      url: `https://github.com/search?q=${githubFormula}&type=code`,
      description: "Searches GitHub repositories with: extension:mxl OR extension:musicxml piano.",
    },
    {
      id: "google-mxl",
      label: `Google Filetype (“${q}” .mxl)`,
      badge: "Web Search",
      url: `https://www.google.com/search?q=${googleFormula}`,
      description: 'Searches Google with: filetype:mxl OR filetype:musicxml "piano".',
    },
    {
      id: "musicxml-dir",
      label: "MusicXML.com Directory",
      badge: "Directory",
      url: "https://www.musicxml.com/music-in-musicxml/",
      description: "Official directory of websites offering MusicXML sheet music.",
    },
  ];
}
