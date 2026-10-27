export type DiagnosticFields = Record<string, string | number | boolean>;

const descriptions: Record<string, string> = {
  "53300": "Limite de conexões PostgreSQL atingido",
  "57014": "Consulta PostgreSQL cancelada ou prazo excedido",
  "42P01": "Relação PostgreSQL não encontrada",
  "42703": "Coluna PostgreSQL não encontrada",
  "42501": "Permissão PostgreSQL insuficiente",
  "23505": "Restrição de unicidade violada",
  "23503": "Referência de dados inexistente",
  "28P01": "Autenticação PostgreSQL recusada",
  "11000": "Chave duplicada no MongoDB",
  ETIMEDOUT: "Prazo de conexão excedido",
  ECONNREFUSED: "Conexão recusada pela dependência",
  ECONNRESET: "Conexão interrompida pela dependência",
  ENOTFOUND: "Não foi possível resolver o endereço da dependência",
};

function kind(error: unknown): string {
  if (!(error instanceof Error)) return "ThrownValue";
  const name = error.constructor.name;
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Error";
}

function code(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const value = String(error.code);
    if (error instanceof Error && ["JobError", "SourceError"].includes(error.constructor.name) && /^[a-z][a-z0-9_]{1,79}$/.test(value)) return value;
    if (/^(?:[0-9A-Z]{5}|E[A-Z_]{2,30}|[A-Z][A-Z0-9_]{1,47}|\d{1,6})$/.test(value)) return value;
  }
  if (error instanceof Error && /^(TimeoutError|AbortError)$/.test(error.name)) return error.name;
  return "UNCLASSIFIED_ERROR";
}

function frames(error: unknown): string {
  if (!(error instanceof Error)) return "";
  return (error.stack ?? "").slice(0, 16000).split("\n").slice(1)
    .filter(line => /^\s+at /.test(line))
    .flatMap(line => {
      const found = line.match(/(?:^|[/(\\\s])([A-Za-z0-9_.-]+\.(?:[cm]?js|tsx?)):(\d{1,7}):(\d{1,7})\)?$/);
      return found ? [`${found[1]}:${found[2]}:${found[3]}`] : [];
    }).slice(0, 12).join(" > ");
}

export class ObservedFailure extends Error {
  readonly stage: string;
  readonly dependency: string;
  readonly durationMs: number;
  constructor(stage: string, dependency: string, durationMs: number, cause: unknown) {
    super(`Falha na etapa ${stage} da dependência ${dependency}`, { cause });
    this.stage = stage;
    this.dependency = dependency;
    this.durationMs = durationMs;
  }
}

const observations = new WeakMap<object, ObservedFailure>();

export async function observe<T>(stage: string, dependency: string, work: () => Promise<T> | T): Promise<T> {
  const start = Date.now();
  try { return await work(); }
  catch (error) {
    if (error !== null && typeof error === "object" && !observations.has(error)) {
      observations.set(error, new ObservedFailure(stage, dependency, Date.now() - start, error));
    }
    throw error;
  }
}

export function diagnostic(error: unknown): DiagnosticFields {
  let context: ObservedFailure | undefined;
  let original = error;
  const visited = new Set<unknown>();
  while (original instanceof Error && !visited.has(original) && visited.size < 5) {
    visited.add(original);
    context = observations.get(original) ?? context;
    if (original instanceof ObservedFailure) context = original;
    if (!original.cause || visited.has(original.cause)) break;
    original = original.cause;
  }
  const errorCode = code(original);
  const result: DiagnosticFields = {
    error_type: kind(original), error_code: errorCode,
    error_message: descriptions[errorCode] ?? (context?.message ?? "Falha operacional; consulte o tipo, código e localização"),
    error_frames: frames(original),
  };
  if (context) Object.assign(result, { stage: context.stage, dependency: context.dependency, dependency_duration_ms: context.durationMs });
  const causes: string[] = [];
  const seen = new Set<unknown>();
  let current = original;
  while (current instanceof Error && !seen.has(current) && causes.length < 4) {
    seen.add(current); causes.push(`${kind(current)}:${code(current)}`); current = current.cause;
  }
  if (causes.length) result.error_causes = causes.join(" > ");
  return result;
}
