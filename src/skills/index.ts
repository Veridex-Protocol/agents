/**
 * @packageDocumentation
 * @module skills
 * @description
 * First-class Skill primitive for the Veridex Agent Fabric (Phase 4).
 *
 * Public surface:
 *   - {@link SkillContract}, {@link SkillFrontmatter}, {@link SkillTrigger}
 *   - {@link parseSkillDocument}
 *   - {@link SkillRegistry}, {@link renderSkillDetail}
 *   - {@link SkillResolver}
 *   - {@link loadSkillPack}, {@link writeSkillArtifacts}
 *   - {@link checkResolvable}, {@link dryAudit}
 *   - {@link skillify}
 *   - {@link createLoadSkillBuiltin}, {@link createFindSkillsBuiltin},
 *     {@link createSkillManageBuiltin}, {@link SkillProposal}
 *   - {@link runSkillsCli}
 */

export type {
  SkillContract,
  SkillFrontmatter,
  SkillTrigger,
  SkillKind,
  SkillSource,
  SkillSummary,
  SkillMatch,
  SkillScriptRef,
  SkillToolRef,
  SkillTestRef,
} from './types';

export { parseSkillDocument, hashSkillContent } from './parser';
export type { ParseSkillOptions, YamlParser } from './parser';

export {
  SkillRegistry,
  frontmatterToSummary,
  renderSkillDetail,
} from './SkillRegistry';
export type { SkillLookup } from './SkillRegistry';

export { SkillResolver } from './SkillResolver';
export type {
  SkillResolverOptions,
  ResolverStrategy,
  ResolverContext,
} from './SkillResolver';

export {
  loadSkillPack,
  writeSkillArtifacts,
} from './SkillPack';
export type {
  SkillPackManifest,
  LoadedSkillPack,
  LoadSkillPackOptions,
} from './SkillPack';

export { checkResolvable, dryAudit } from './audit';
export type {
  ResolvableIssue,
  ResolvableIssueKind,
  CheckResolvableOptions,
  DryIssue,
  DryIssueKind,
  DryAuditOptions,
} from './audit';

export { skillify } from './skillify';
export type {
  SkillifyInput,
  SkillifyResult,
  SkillifyArtifact,
} from './skillify';

export {
  createLoadSkillBuiltin,
  createFindSkillsBuiltin,
  createSkillManageBuiltin,
} from './SkillTools';
export type {
  SkillProposal,
  SkillProposalHandler,
  SkillManageOptions,
} from './SkillTools';

export { runSkillsCli } from './cli';
export type { CliResult, CliIO } from './cli';
