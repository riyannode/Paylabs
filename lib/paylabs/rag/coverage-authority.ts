/** Deterministic final coverage authority shared by retrieval, packs, retries, and diagnostics. */

export type CoverageMatrixRow = {
  entity: string;
  coveredAspects: string[];
};

export type MissingCoverageCell = {
  entity: string;
  aspect: string;
};

export type AuthoritativeCoverage = {
  comparisonMatrixRequired: boolean;
  coveredEntities: string[];
  missingEntities: string[];
  missingEntityRows: string[];
  coveredAspects: string[];
  missingAspects: string[];
  missingEntityAspectCells: MissingCoverageCell[];
  complete: boolean;
};

export function evaluateAuthoritativeCoverage(params: {
  requiredEntities: string[];
  requestedAspects: string[];
  comparisonLike: boolean;
  rows: CoverageMatrixRow[];
}): AuthoritativeCoverage {
  const { requiredEntities, requestedAspects, comparisonLike, rows } = params;
  const comparisonMatrixRequired = comparisonLike && requiredEntities.length > 1;
  const rowByEntity = new Map(rows.map((row) => [row.entity.toLowerCase(), row]));
  const requiredAspectSet = new Set(requestedAspects);
  const coveredEntities = requiredEntities.filter((entity) => {
    const row = rowByEntity.get(entity.toLowerCase());
    return comparisonMatrixRequired
      ? Boolean(row && row.coveredAspects.length > 0)
      : Boolean(row);
  });
  const missingEntities = requiredEntities.filter((entity) => !coveredEntities.includes(entity));
  const missingEntityRows = requiredEntities.filter(
    (entity) => !rowByEntity.has(entity.toLowerCase()),
  );
  const coveredAspects = requestedAspects.filter((aspect) => rows.some((row) => row.coveredAspects.includes(aspect)));
  const missingAspects = requestedAspects.filter((aspect) => !coveredAspects.includes(aspect));
  const missingEntityAspectCells: MissingCoverageCell[] = [];

  if (comparisonMatrixRequired) {
    for (const entity of requiredEntities) {
      const row = rowByEntity.get(entity.toLowerCase());
      for (const aspect of requestedAspects) {
        if (!row || !row.coveredAspects.includes(aspect)) {
          missingEntityAspectCells.push({ entity, aspect });
        }
      }
    }
  }

  const complete = comparisonMatrixRequired
    ? missingEntityAspectCells.length === 0
      && missingEntities.length === 0
      && missingAspects.length === 0
    : missingEntities.length === 0 && missingAspects.length === 0;

  return {
    comparisonMatrixRequired,
    coveredEntities,
    missingEntities,
    missingEntityRows,
    coveredAspects,
    missingAspects,
    missingEntityAspectCells,
    complete,
  };
}

export function buildBalancedMissingCells(params: {
  requiredEntities: string[];
  requestedAspects: string[];
  coverage: AuthoritativeCoverage;
  priority?: MissingCoverageCell[];
  maxCells: number;
}): MissingCoverageCell[] {
  const { requiredEntities, requestedAspects, coverage, priority = [], maxCells } = params;
  if (!coverage.comparisonMatrixRequired) return [];
  const missing = new Set(coverage.missingEntityAspectCells.map((cell) => `${cell.entity.toLowerCase()}|${cell.aspect}`));
  const queues = new Map<string, string[]>();
  for (const entity of requiredEntities) queues.set(entity.toLowerCase(), []);
  for (const cell of coverage.missingEntityAspectCells) queues.get(cell.entity.toLowerCase())?.push(cell.aspect);
  const ordered: MissingCoverageCell[] = [];
  const seen = new Set<string>();
  const add = (entity: string, aspect: string) => {
    const key = `${entity.toLowerCase()}|${aspect}`;
    if (!missing.has(key) || seen.has(key) || ordered.length >= maxCells) return;
    seen.add(key);
    ordered.push({ entity, aspect });
  };
  for (const entity of requiredEntities) add(entity, queues.get(entity.toLowerCase())?.shift() ?? "");
  while (ordered.length < maxCells) {
    let added = false;
    for (const entity of requiredEntities) {
      const aspect = queues.get(entity.toLowerCase())?.shift();
      if (!aspect) continue;
      add(entity, aspect);
      added = true;
      if (ordered.length >= maxCells) break;
    }
    if (!added) break;
  }
  for (const cell of priority) add(cell.entity, cell.aspect);
  return ordered.slice(0, maxCells);
}
