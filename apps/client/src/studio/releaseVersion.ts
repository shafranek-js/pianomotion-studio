/** Visible release identity. The package version advances by release milestone,
 * while the immutable content build ID changes with every changed production build.
 */
export function formatStudioReleaseVersion(packageVersion: string, buildId: string): string {
  const normalized = packageVersion.trim();
  return /^[a-f0-9]{24}$/.test(buildId)
    ? `${normalized}+${buildId.slice(0, 8)}`
    : normalized;
}
