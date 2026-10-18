import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Music2 } from "lucide-react";
import { deleteProject, getRecentSavedProjects, listProjects, type ProjectSummary, type SavedProject } from "../storage";
import { useI18n } from "../i18n";
import styles from "./ProjectsPanel.module.css";

export interface ProjectsPanelProps {
  onOpenProject(projectId: string): void;
  onOpenBuiltinMelodies?(): void;
  onExportProject?(projectId: string): void;
  activeProjectId?: string | null;
}

export function ProjectsPanel({ onOpenProject, onOpenBuiltinMelodies, onExportProject, activeProjectId }: ProjectsPanelProps) {
  const { dict, t } = useI18n();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [recent, setRecent] = useState<SavedProject[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mountedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [allProjects, recentProjects] = await Promise.all([listProjects(), getRecentSavedProjects()]);
      if (!mountedRef.current) return;
      setError("");
      setProjects(allProjects);
      setRecent(recentProjects);
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void Promise.resolve().then(refresh);
    const onProjectsChanged = () => { void refresh(); };
    window.addEventListener("studio-projects-changed", onProjectsChanged);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("studio-projects-changed", onProjectsChanged);
    };
  }, [refresh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? projects.filter((project) => project.name.toLocaleLowerCase().includes(needle) || project.projectId.toLocaleLowerCase().includes(needle))
      : projects;
  }, [projects, query]);

  const removeProject = async (project: ProjectSummary) => {
    if (!window.confirm(t("projects.confirmDelete", { name: project.name }))) return;
    setError("");
    try {
      await deleteProject(project.projectId);
      setLoading(true);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className={styles.panel} aria-label={dict.projects.title}>
      {onOpenBuiltinMelodies && (
        <button className={styles.builtins} type="button" onClick={onOpenBuiltinMelodies}>
          <Music2 size={17} aria-hidden="true" />
          <span>{dict.welcome.browseMelodies}</span>
        </button>
      )}
      <label className={styles.searchLabel} htmlFor="studio-project-search">{dict.common.search}</label>
      <input
        id="studio-project-search"
        className={styles.search}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={dict.common.search}
        autoComplete="off"
      />
      {error && <p className={styles.error} role="alert">{error}</p>}
      {recent.length > 0 && (
        <div className={styles.recentSection}>
          <h3>{dict.welcome.recentProjects}</h3>
          <ul className={styles.list}>
            {recent.filter((project) => {
              const needle = query.trim().toLocaleLowerCase();
              return !needle || project.name.toLocaleLowerCase().includes(needle) || project.projectId.toLocaleLowerCase().includes(needle);
            }).map((project) => (
              <li className={styles.row} key={"recent-" + project.projectId}>
                <button
                  className={styles.open}
                  type="button"
                  onClick={() => onOpenProject(project.projectId)}
                  title={dict.projects.open}
                  aria-label={`${dict.projects.open}: ${project.name}`}
                >
                  <span className={styles.name}>{project.name}</span>
                  <span className={styles.meta}>Recently opened · {project.document.notes.length.toLocaleString()} notes</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <h3 className={styles.allHeading}>{dict.projects.savedInBrowser}</h3>
      {loading ? (
        <p className={styles.empty} role="status">{dict.common.loading}</p>
      ) : filtered.length === 0 ? (
        <p className={styles.empty}>{projects.length === 0 ? dict.projects.noProjects : "No projects match this search."}</p>
      ) : (
        <ul className={styles.list}>
          {filtered.map((project) => (
            <li className={styles.row} key={project.projectId} data-testid="studio-project-row">
              <button
                className={styles.open}
                type="button"
                onClick={() => onOpenProject(project.projectId)}
                aria-current={activeProjectId === project.projectId ? "true" : undefined}
                title={dict.projects.open}
                aria-label={`${dict.projects.open}: ${project.name}`}
              >
                <span className={styles.name}>{project.name}</span>
                <span className={styles.meta}>{project.noteCount.toLocaleString()} notes · {t("projects.lastModified", { date: new Date(project.updatedAt).toLocaleDateString() })}</span>
              </button>
              {onExportProject && (
                <button
                  className={styles.delete}
                  type="button"
                  onClick={() => onExportProject(project.projectId)}
                  aria-label={`${dict.projects.export} ${project.name}`}
                  title={dict.projects.export}
                >
                  {dict.projects.export}
                </button>
              )}
              <button
                className={styles.delete}
                type="button"
                onClick={() => void removeProject(project)}
                aria-label={`${dict.projects.delete} ${project.name}`}
                title={dict.projects.delete}
              >
                {dict.projects.delete}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button className={styles.refresh} type="button" onClick={() => { setLoading(true); void refresh(); }}>{dict.common.retry}</button>
    </section>
  );
}
