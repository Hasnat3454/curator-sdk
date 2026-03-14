export type FieldType = "text" | "url" | "int64" | "float64" | "bool" | "date" | "relation";

export interface FieldConfig {
  column: string;
  propertyName: string;
  wellKnownId?: string;
  type: FieldType;
  relationEntityType?: string;
  required?: boolean;
}

export interface EntityTypeConfig {
  name: string;
  description?: string;
  wellKnownId?: string;
}

export interface BountyConfig {
  bountyName: string;
  editName: string;
  entityType: EntityTypeConfig;
  fields: FieldConfig[];
  deduplicateByField?: string;
  network?: "TESTNET" | "MAINNET";
}

export interface ImportResult {
  created: number;
  skipped: number;
  errors: string[];
  transactionHash?: string;
  spaceId?: string;
  editId?: string;
  cid?: string;
}
