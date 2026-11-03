import type { AppLanguage } from "../i18n";

const en = {
  title: "Melody library",
  chooseFolderCopy: "Choose folder copy…",
  builtIn: "Built-in", myFolder: "My folder", allSources: "All libraries",
  connectFolder: "Connect folder…", changeFolder: "Change folder…", rescan: "Refresh folder",
  grantAccess: "Allow folder access", cachedCopy: "Saved copy", folderHelp: "Files in this folder are read only. Refresh to find changes.",
  fallbackHelp: "A copy is saved in this browser. Select the folder again to refresh it.",
  indexing: "Indexing folder", cancelScan: "Cancel scan", recent: "Recent", allFolders: "All folders",
  preview: "Preview", stopPreview: "Stop preview", notes: "notes",
  sortTitle: "Title (A–Z)", sortEasiest: "Easiest first", sortHardest: "Hardest first",
  sortDurationAsc: "Shortest first", sortDurationDesc: "Longest first", sortAdded: "Recently added",
  sortDateAddedAsc: "Oldest added first", emptyFolder: "Connect a folder to browse your scores.",
  noRecent: "No recently opened melodies yet.", scanErrors: "Some files could not be indexed",
  dropFolder: "Drop a folder here", source: "Library", unknownDuration: "Duration unavailable",
  previewError: "Could not preview this melody.", category: "Folder category", allCategories: "All folders",
  noMatches: "No melodies match your search.", noFavorites: "No favorite melodies yet.",
  emptyAll: "No melodies available.", localLoadError: "Could not load the local library.",
  unsupportedFolderPicker: "Select a folder to save a copy in this browser.",
  directoryReadError: "Could not read this folder.", previewUnavailable: "Preview unavailable",
  progressOf: "of",
};

export type LibraryStrings = typeof en;

const translations: Record<AppLanguage, LibraryStrings> = {
  en,
  cs: {
    title: "Knihovna skladeb",
    chooseFolderCopy: "Vybrat kopii složky…",
    builtIn: "Vestavěné", myFolder: "Moje složka", allSources: "Všechny knihovny", connectFolder: "Připojit složku…", changeFolder: "Změnit složku…", rescan: "Obnovit složku", grantAccess: "Povolit přístup ke složce", cachedCopy: "Uložená kopie", folderHelp: "Soubory ve složce se pouze čtou. Změny načtete obnovením.", fallbackHelp: "Kopie je uložená v tomto prohlížeči. Pro obnovení vyberte složku znovu.", indexing: "Indexování složky", cancelScan: "Zrušit skenování", recent: "Nedávné", allFolders: "Všechny složky", preview: "Poslechnout ukázku", stopPreview: "Zastavit ukázku", notes: "not", sortTitle: "Název (A–Z)", sortEasiest: "Od nejlehčích", sortHardest: "Od nejtěžších", sortDurationAsc: "Od nejkratších", sortDurationDesc: "Od nejdelších", sortAdded: "Nedávno přidané", sortDateAddedAsc: "Nejdříve nejstarší", emptyFolder: "Připojte složku s vlastními skladbami.", noRecent: "Zatím žádné nedávno otevřené skladby.", scanErrors: "Některé soubory se nepodařilo zpracovat", dropFolder: "Přetáhněte sem složku", source: "Knihovna", unknownDuration: "Délka není dostupná", previewError: "Ukázku se nepodařilo přehrát.", category: "Kategorie složek", allCategories: "Všechny složky", noMatches: "Hledání neodpovídá žádná skladba.", noFavorites: "Zatím žádné oblíbené skladby.", emptyAll: "Žádné dostupné skladby.", localLoadError: "Místní knihovnu se nepodařilo načíst.", unsupportedFolderPicker: "Vyberte složku pro uložení kopie v prohlížeči.", directoryReadError: "Složku se nepodařilo přečíst.", previewUnavailable: "Ukázka není dostupná", progressOf: "z",
  },
  uk: {
    title: "Бібліотека мелодій",
    chooseFolderCopy: "Вибрати копію папки…",
    builtIn: "Вбудовані", myFolder: "Моя папка", allSources: "Усі бібліотеки", connectFolder: "Підключити папку…", changeFolder: "Змінити папку…", rescan: "Оновити папку", grantAccess: "Дозволити доступ до папки", cachedCopy: "Збережена копія", folderHelp: "Файли в папці доступні лише для читання. Оновіть, щоб знайти зміни.", fallbackHelp: "Копію збережено в цьому браузері. Щоб оновити, виберіть папку знову.", indexing: "Індексація папки", cancelScan: "Скасувати сканування", recent: "Нещодавні", allFolders: "Усі папки", preview: "Прослухати уривок", stopPreview: "Зупинити уривок", notes: "нот", sortTitle: "Назва (А–Я)", sortEasiest: "Спочатку простіші", sortHardest: "Спочатку складніші", sortDurationAsc: "Спочатку коротші", sortDurationDesc: "Спочатку довші", sortAdded: "Нещодавно додані", sortDateAddedAsc: "Спочатку найдавніші", emptyFolder: "Підключіть папку зі своїми творами.", noRecent: "Нещодавно відкритих мелодій ще немає.", scanErrors: "Деякі файли не вдалося обробити", dropFolder: "Перетягніть сюди папку", source: "Бібліотека", unknownDuration: "Тривалість невідома", previewError: "Не вдалося відтворити уривок.", category: "Категорія папки", allCategories: "Усі папки", noMatches: "За вашим запитом мелодій не знайдено.", noFavorites: "Улюблених мелодій ще немає.", emptyAll: "Немає доступних мелодій.", localLoadError: "Не вдалося завантажити локальну бібліотеку.", unsupportedFolderPicker: "Виберіть папку, щоб зберегти копію в браузері.", directoryReadError: "Не вдалося прочитати папку.", previewUnavailable: "Уривок недоступний", progressOf: "з",
  },
  de: {
    title: "Melodienbibliothek",
    chooseFolderCopy: "Ordnerkopie auswählen…",
    builtIn: "Integriert", myFolder: "Mein Ordner", allSources: "Alle Bibliotheken", connectFolder: "Ordner verbinden…", changeFolder: "Ordner wechseln…", rescan: "Ordner aktualisieren", grantAccess: "Ordnerzugriff erlauben", cachedCopy: "Gespeicherte Kopie", folderHelp: "Dateien werden nur gelesen. Aktualisieren Sie den Ordner, um Änderungen einzulesen.", fallbackHelp: "Eine Kopie ist in diesem Browser gespeichert. Wählen Sie den Ordner zum Aktualisieren erneut aus.", indexing: "Ordner wird eingelesen", cancelScan: "Einlesen abbrechen", recent: "Zuletzt geöffnet", allFolders: "Alle Ordner", preview: "Hörprobe", stopPreview: "Hörprobe stoppen", notes: "Noten", sortTitle: "Titel (A–Z)", sortEasiest: "Leichteste zuerst", sortHardest: "Schwierigste zuerst", sortDurationAsc: "Kürzeste zuerst", sortDurationDesc: "Längste zuerst", sortAdded: "Zuletzt hinzugefügt", sortDateAddedAsc: "Älteste zuerst", emptyFolder: "Verbinden Sie einen Ordner mit Ihren Stücken.", noRecent: "Noch keine zuletzt geöffneten Melodien.", scanErrors: "Einige Dateien konnten nicht eingelesen werden", dropFolder: "Ordner hier ablegen", source: "Bibliothek", unknownDuration: "Dauer nicht verfügbar", previewError: "Die Hörprobe konnte nicht abgespielt werden.", category: "Ordnerkategorie", allCategories: "Alle Ordner", noMatches: "Keine Melodien entsprechen Ihrer Suche.", noFavorites: "Noch keine Lieblingsmelodien.", emptyAll: "Keine Melodien verfügbar.", localLoadError: "Die lokale Bibliothek konnte nicht geladen werden.", unsupportedFolderPicker: "Wählen Sie einen Ordner aus, um eine Kopie im Browser zu speichern.", directoryReadError: "Der Ordner konnte nicht gelesen werden.", previewUnavailable: "Hörprobe nicht verfügbar", progressOf: "von",
  },
  es: {
    title: "Biblioteca de melodías",
    chooseFolderCopy: "Elegir copia de carpeta…",
    builtIn: "Integradas", myFolder: "Mi carpeta", allSources: "Todas las bibliotecas", connectFolder: "Conectar carpeta…", changeFolder: "Cambiar carpeta…", rescan: "Actualizar carpeta", grantAccess: "Permitir acceso a la carpeta", cachedCopy: "Copia guardada", folderHelp: "Los archivos solo se leen. Actualiza la carpeta para encontrar cambios.", fallbackHelp: "Se guarda una copia en este navegador. Selecciona la carpeta de nuevo para actualizarla.", indexing: "Indexando carpeta", cancelScan: "Cancelar exploración", recent: "Recientes", allFolders: "Todas las carpetas", preview: "Escuchar fragmento", stopPreview: "Detener fragmento", notes: "notas", sortTitle: "Título (A–Z)", sortEasiest: "Más fáciles primero", sortHardest: "Más difíciles primero", sortDurationAsc: "Más cortas primero", sortDurationDesc: "Más largas primero", sortAdded: "Añadidas recientemente", sortDateAddedAsc: "Más antiguas primero", emptyFolder: "Conecta una carpeta con tus partituras.", noRecent: "Todavía no hay melodías abiertas recientemente.", scanErrors: "No se pudieron indexar algunos archivos", dropFolder: "Arrastra una carpeta aquí", source: "Biblioteca", unknownDuration: "Duración no disponible", previewError: "No se pudo reproducir el fragmento.", category: "Categoría de carpeta", allCategories: "Todas las carpetas", noMatches: "Ninguna melodía coincide con la búsqueda.", noFavorites: "Todavía no hay melodías favoritas.", emptyAll: "No hay melodías disponibles.", localLoadError: "No se pudo cargar la biblioteca local.", unsupportedFolderPicker: "Selecciona una carpeta para guardar una copia en el navegador.", directoryReadError: "No se pudo leer la carpeta.", previewUnavailable: "Fragmento no disponible", progressOf: "de",
  },
  it: {
    title: "Libreria di melodie",
    chooseFolderCopy: "Scegli copia della cartella…",
    builtIn: "Integrate", myFolder: "La mia cartella", allSources: "Tutte le librerie", connectFolder: "Collega cartella…", changeFolder: "Cambia cartella…", rescan: "Aggiorna cartella", grantAccess: "Consenti accesso alla cartella", cachedCopy: "Copia salvata", folderHelp: "I file vengono solo letti. Aggiorna la cartella per trovare le modifiche.", fallbackHelp: "Una copia è salvata in questo browser. Seleziona nuovamente la cartella per aggiornarla.", indexing: "Indicizzazione della cartella", cancelScan: "Annulla scansione", recent: "Recenti", allFolders: "Tutte le cartelle", preview: "Ascolta anteprima", stopPreview: "Ferma anteprima", notes: "note", sortTitle: "Titolo (A–Z)", sortEasiest: "Prima le più facili", sortHardest: "Prima le più difficili", sortDurationAsc: "Prima le più brevi", sortDurationDesc: "Prima le più lunghe", sortAdded: "Aggiunte di recente", sortDateAddedAsc: "Prima le meno recenti", emptyFolder: "Collega una cartella con i tuoi spartiti.", noRecent: "Nessuna melodia aperta di recente.", scanErrors: "Impossibile indicizzare alcuni file", dropFolder: "Trascina qui una cartella", source: "Libreria", unknownDuration: "Durata non disponibile", previewError: "Impossibile riprodurre l’anteprima.", category: "Categoria della cartella", allCategories: "Tutte le cartelle", noMatches: "Nessuna melodia corrisponde alla ricerca.", noFavorites: "Nessuna melodia preferita.", emptyAll: "Nessuna melodia disponibile.", localLoadError: "Impossibile caricare la libreria locale.", unsupportedFolderPicker: "Seleziona una cartella per salvare una copia nel browser.", directoryReadError: "Impossibile leggere la cartella.", previewUnavailable: "Anteprima non disponibile", progressOf: "di",
  },
};

export function getLibraryStrings(language: AppLanguage): LibraryStrings {
  return translations[language];
}
