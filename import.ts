import "dotenv/config";
import { readFileSync } from "fs";
import { extname, resolve } from "path";
import { parse as parseCsv } from "csv-parse/sync";
import { Graph } from "@geoprotocol/geo-sdk";
import type { Op, Id } from "@geoprotocol/geo-sdk";
import type { BountyConfig, FieldType, ImportResult } from "./src/types.js";
import { queryEntityByName, queryPropertyByName, queryTypeByName, publishOps } from "./src/functions.js";

// ─── Data loading ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
  const config = get("--config");
  const data = get("--data");
  if (!config || !data) {
    console.error("Usage: npx tsx import.ts --config <config.json> --data <data.json|data.csv>");
    process.exit(1);
  }
  return { config, data };
}

function loadRecords(filePath: string): Record<string, unknown>[] {
  const content = readFileSync(resolve(filePath), "utf-8");
  const ext = extname(filePath).toLowerCase();
  if (ext === ".json") {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error("Data file must be a JSON array.");
    return parsed;
  }
  if (ext === ".csv") {
    return parseCsv(content, { columns: true, skip_empty_lines: true, trim: true });
  }
  throw new Error(`Unsupported format: ${ext}. Use .json or .csv`);
}

// ─── Type helpers ─────────────────────────────────────────────────────────────

function toGeoDataType(t: FieldType): string {
  if (t === "int64")    return "INT64";
  if (t === "float64")  return "FLOAT64";
  if (t === "bool")     return "BOOLEAN";
  if (t === "date")     return "DATE";
  if (t === "relation") return "RELATION";
  return "TEXT";
}

function toValueType(t: FieldType): "text" | "int64" | "float64" | "bool" | "date" {
  if (t === "int64")   return "int64";
  if (t === "float64") return "float64";
  if (t === "bool")    return "bool";
  if (t === "date")    return "date";
  return "text";
}

function coerce(value: unknown, t: FieldType): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (t === "int64")  { const n = parseInt(String(value), 10); return isNaN(n) ? null : n; }
  if (t === "float64"){ const n = parseFloat(String(value));   return isNaN(n) ? null : n; }
  if (t === "bool")   return typeof value === "boolean" ? value : String(value).toLowerCase() === "true";
  return String(value).trim();
}

function splitValues(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).map(s => s.trim()).filter(Boolean);
  return String(raw).split(",").map(s => s.trim()).filter(Boolean);
}

// ─── Schema resolution ────────────────────────────────────────────────────────

async function resolveProperty(
  propertyName: string,
  type: FieldType,
  wellKnownId: string | undefined,
  ops: Op[],
  network: "TESTNET" | "MAINNET"
): Promise<string> {
  if (wellKnownId) return wellKnownId;
  const existing = await queryPropertyByName(propertyName, network);
  if (existing) return existing;
  const result = Graph.createProperty({ name: propertyName, dataType: toGeoDataType(type) as any });
  ops.push(...result.ops);
  return result.id;
}

async function resolveType(
  name: string,
  wellKnownId: string | undefined,
  propertyIds: string[],
  ops: Op[],
  network: "TESTNET" | "MAINNET"
): Promise<string> {
  if (wellKnownId) return wellKnownId;
  const existing = await queryTypeByName(name, network);
  if (existing) return existing;
  const result = Graph.createType({ name, properties: propertyIds as Id[] });
  ops.push(...result.ops);
  return result.id;
}

// ─── Import ───────────────────────────────────────────────────────────────────

async function runImport(
  config: BountyConfig,
  records: Record<string, unknown>[],
  privateKey: `0x${string}`
): Promise<ImportResult> {
  const network = config.network ?? "TESTNET";
  const result: ImportResult = { created: 0, skipped: 0, errors: [] };
  const allOps: Op[] = [];

  console.log(`\nBounty: ${config.bountyName}`);
  console.log(`Records: ${records.length} | Network: ${network}\n`);

  const valueFields    = config.fields.filter(f => f.type !== "relation");
  const relationFields = config.fields.filter(f => f.type === "relation");
  const schemaOps: Op[] = [];
  const propIdMap = new Map<string, string>();

  for (const f of [...valueFields, ...relationFields]) {
    const id = await resolveProperty(f.propertyName, f.type, f.wellKnownId, schemaOps, network);
    propIdMap.set(f.column, id);
  }

  const typeId = await resolveType(
    config.entityType.name,
    config.entityType.wellKnownId,
    [...propIdMap.values()],
    schemaOps,
    network
  );
  allOps.push(...schemaOps);

  const relLookup = new Map<string, Map<string, string>>();
  const relOps: Op[] = [];

  for (const f of relationFields) {
    const lookup = new Map<string, string>();
    relLookup.set(f.column, lookup);

    const unique = new Set<string>();
    for (const rec of records) splitValues(rec[f.column]).forEach(v => unique.add(v));

    for (const v of unique) {
      const existingId = await queryEntityByName(v, network);
      if (existingId) {
        lookup.set(v, existingId);
      } else {
        const e = Graph.createEntity({ name: v, types: [], values: [] });
        relOps.push(...e.ops);
        lookup.set(v, e.id);
      }
    }
  }
  allOps.push(...relOps);

  const dedupField = config.deduplicateByField ?? "name";
  const recordOps: Op[] = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const entityName = String(rec[dedupField] ?? rec["name"] ?? `Record ${i + 1}`);

    const missing = config.fields.filter(f => f.required && !rec[f.column]).map(f => f.column);
    if (missing.length) {
      const msg = `"${entityName}" missing required fields: ${missing.join(", ")}`;
      console.warn(`  skipped — ${msg}`);
      result.errors.push(msg);
      result.skipped++;
      continue;
    }

    if (await queryEntityByName(entityName, network)) {
      console.log(`  skipped — already exists: "${entityName}"`);
      result.skipped++;
      continue;
    }

    const values: Array<{ property: Id; type: any; value: unknown }> = [];
    for (const f of valueFields) {
      const raw = rec[f.column];
      if (raw === undefined || raw === null || raw === "") continue;
      const v = coerce(raw, f.type);
      if (v === null) continue;
      values.push({ property: propIdMap.get(f.column)! as Id, type: toValueType(f.type), value: v });
    }

    const entity = Graph.createEntity({ name: entityName, types: [typeId as Id], values: values as any });
    recordOps.push(...entity.ops);

    for (const f of relationFields) {
      const lookup = relLookup.get(f.column);
      if (!lookup) continue;
      for (const v of splitValues(rec[f.column])) {
        const targetId = lookup.get(v);
        if (!targetId) continue;
        const rel = Graph.createRelation({
          fromEntity: entity.id,
          toEntity: targetId as Id,
          type: propIdMap.get(f.column)! as Id,
        });
        recordOps.push(...rel.ops);
      }
    }

    console.log(`  [${i + 1}/${records.length}] ${entityName}`);
    result.created++;
  }
  allOps.push(...recordOps);

  console.log(`\nPublishing ${allOps.length} ops...`);

  if (allOps.length === 0) {
    console.log("Nothing to publish — all records already exist.");
    return result;
  }

  const pub = await publishOps({
    ops: allOps,
    editName: config.editName,
    privateKey,
    useSmartAccount: true,
    network,
  });

  if (pub.success) {
    console.log(`\nPublished successfully!`);
    console.log(`Space : ${pub.spaceId}`);
    console.log(`Edit  : ${pub.editId}`);
    console.log(`TX    : ${pub.transactionHash}`);
    result.transactionHash = pub.transactionHash;
    result.spaceId = pub.spaceId;
    result.editId = pub.editId;
    result.cid = pub.cid;
  } else {
    console.error(`\nPublish failed: ${pub.error}`);
    result.errors.push(pub.error ?? "Unknown error");
  }

  return result;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const { config: configPath, data: dataPath } = parseArgs();

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
if (!PRIVATE_KEY) {
  console.error("PRIVATE_KEY is not set. Export your wallet from https://www.geobrowser.io/export-wallet");
  process.exit(1);
}

const config: BountyConfig = JSON.parse(readFileSync(resolve(configPath), "utf-8"));
const records = loadRecords(dataPath);

console.log(`Config : ${configPath}`);
console.log(`Data   : ${dataPath} (${records.length} records)`);

const result = await runImport(config, records, PRIVATE_KEY);

console.log(`\n— Summary —`);
console.log(`Created : ${result.created}`);
console.log(`Skipped : ${result.skipped}`);
if (result.errors.length > 0) {
  console.log(`Errors  : ${result.errors.length}`);
  result.errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
}
