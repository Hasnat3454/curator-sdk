# Geo Bounty SDK

Generic SDK for publishing bounty datasets to the [Geo knowledge graph](https://geobrowser.io).

One entry point (`import.ts`) reads a config file and a data file, then publishes entities to a Geo space. Works for any bounty — just swap the config and data.

## Setup

```bash
npm install
cp .env .env.local   # or edit .env directly
```

Set your private key in `.env`:

```
PRIVATE_KEY=0x...
```

Export your key from [geobrowser.io/export-wallet](https://www.geobrowser.io/export-wallet).

## Usage

```bash
# Preview (no transaction)
npx tsx import.ts --config <config.json> --data <data.json|csv> --dry-run

# Publish
npx tsx import.ts --config <config.json> --data <data.json|csv>
```

## AI Datasets Bounty

```bash
# Dry run first
npx tsx import.ts --config bounties/ai-datasets.config.json --data data_to_publish/ai-datasets.json --dry-run

# Publish 100 AI datasets to Geo space 7429dfda5f14718fc6f603622bade857
npx tsx import.ts --config bounties/ai-datasets.config.json --data data_to_publish/ai-datasets.json
```

## Adding a New Bounty

1. Create a config in `bounties/your-bounty.config.json`
2. Create a data file in `data_to_publish/your-data.json` (array of objects) or `.csv`
3. Run with `--dry-run` to verify, then publish

## Config Format

```json
{
  "bountyName": "My Bounty",
  "editName": "Add My Bounty Data",
  "spaceId": "your-32-char-hex-space-id",
  "network": "TESTNET",
  "entityType": {
    "name": "MyType",
    "wellKnownId": "optional-existing-type-id"
  },
  "fields": [
    {
      "column": "name",
      "propertyName": "Name",
      "wellKnownId": "a126ca530c8e48d5b88882c734c38935",
      "type": "text",
      "required": true
    },
    {
      "column": "year",
      "propertyName": "Year",
      "type": "int64"
    },
    {
      "column": "topic",
      "propertyName": "Topic",
      "type": "relation",
      "relationEntityType": "Topic"
    }
  ],
  "deduplicateByField": "name"
}
```

### Field types

| `type`    | Geo DataType | Notes |
|-----------|-------------|-------|
| `text`    | TEXT        |       |
| `url`     | TEXT        | Use `wellKnownId: PROPERTIES.web_url` for URL semantics |
| `int64`   | INTEGER     |       |
| `float64` | FLOAT       |       |
| `bool`    | BOOLEAN     |       |
| `date`    | DATE        | ISO 8601: `YYYY-MM-DD` |
| `relation`| RELATION    | Set `relationEntityType` to type the target entities |

### Well-known IDs (root space)

| Property | ID |
|----------|----|
| Name | `a126ca530c8e48d5b88882c734c38935` |
| Description | `9b1f76ff9711404c861e59dc3fa7d037` |
| Web URL | `eed38e74e67946bf8a42ea3e4f8fb5fb` |

Use `wellKnownId` on any field to reuse an existing property/type instead of creating a new one.

## Project Structure

```
sdk-geo/
├── import.ts                        # CLI entry point
├── src/
│   ├── types.ts                     # BountyConfig, FieldConfig interfaces
│   ├── functions.ts                 # gql, publishOps, entity lookups
│   └── constants.ts                 # Well-known Geo ontology IDs
├── bounties/
│   └── ai-datasets.config.json      # Config for AI datasets bounty
└── data_to_publish/
    └── ai-datasets.json             # 100 AI datasets
```
