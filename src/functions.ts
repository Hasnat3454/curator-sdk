import { createPublicClient, type Hex, http } from "viem";
import {
  daoSpace,
  getSmartAccountWalletClient,
  getWalletClient,
  personalSpace,
  TESTNET_RPC_URL,
  type Op,
} from "@geoprotocol/geo-sdk";
import { SpaceRegistryAbi } from "@geoprotocol/geo-sdk/abis";
import { TESTNET } from "@geoprotocol/geo-sdk/contracts";
import { API_ENDPOINTS } from "./constants.js";
// TYPES.property and TYPES.type are used for type-scoped entity lookups (Issue #2 fix)
import { TYPES } from "./constants.js";

export interface PublishResult {
  success: boolean;
  editId?: string;
  cid?: string;
  transactionHash?: string;
  spaceId?: string;
  error?: string;
}

export interface PublishConfig {
  ops: Op[];
  editName: string;
  privateKey: `0x${string}`;
  useSmartAccount?: boolean;
  network?: "TESTNET" | "MAINNET";
  spaceId?: string;
}

// ─── GraphQL helper ───────────────────────────────────────────────────────────

export async function gql(
  query: string,
  variables?: Record<string, unknown>,
  network: "TESTNET" | "MAINNET" = "TESTNET"
): Promise<any> {
  const res = await fetch(API_ENDPOINTS[network], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL: ${json.errors[0].message}`);
  return json.data;
}

// ─── Entity lookup helpers ────────────────────────────────────────────────────

/**
 * Look up any entity by name (free-text search, no type filter).
 * Used for deduplication checks before creating new entities.
 */
export async function queryEntityByName(
  name: string,
  network: "TESTNET" | "MAINNET" = "TESTNET"
): Promise<string | null> {
  try {
    const data = await gql(
      `{ search(query: ${JSON.stringify(name)}, first: 5) { id name } }`,
      undefined,
      network
    );
    const match = (data?.search ?? []).find(
      (e: any) => e.name?.toLowerCase() === name.toLowerCase()
    );
    return match?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Look up a PROPERTY entity by name, filtered to type=Property.
 *
 * FIX (Issue #2): The generic search() returns ALL entity types — content
 * entities, Role entities, etc. — so for common names like "Creator" it
 * could return a non-property entity and corrupt the knowledge graph.
 * We filter by TYPES.property to guarantee we only match actual properties.
 */
export async function queryPropertyByName(
  name: string,
  network: "TESTNET" | "MAINNET" = "TESTNET"
): Promise<string | null> {
  try {
    const data = await gql(
      `{ entities(filter: {
           types: { some: { typeId: { is: "${TYPES.property}" } } },
           name: { is: ${JSON.stringify(name)} }
         }, first: 1) { id name } }`,
      undefined,
      network
    );
    return data?.entities?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Look up a TYPE entity by name, filtered to type=Type.
 *
 * FIX (Issue #2): Same as above — generic search() would match any entity
 * named e.g. "Dataset", including content entities. We filter to TYPES.type.
 */
export async function queryTypeByName(
  name: string,
  network: "TESTNET" | "MAINNET" = "TESTNET"
): Promise<string | null> {
  try {
    const data = await gql(
      `{ entities(filter: {
           types: { some: { typeId: { is: "${TYPES.type}" } } },
           name: { is: ${JSON.stringify(name)} }
         }, first: 1) { id name } }`,
      undefined,
      network
    );
    return data?.entities?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

// ─── Space helpers ────────────────────────────────────────────────────────────

function createGeoPublicClient() {
  return createPublicClient({ transport: http(TESTNET_RPC_URL) });
}

async function ensurePersonalSpace(
  address: string,
  walletClient: Awaited<ReturnType<typeof getSmartAccountWalletClient>>
): Promise<string> {
  const publicClient = createGeoPublicClient();
  const hasSpace = await personalSpace.hasSpace({ address: address as `0x${string}` });

  if (!hasSpace) {
    console.log("Creating personal space...");
    const { to, calldata } = personalSpace.createSpace();
    const txHash = await walletClient.sendTransaction({ to, data: calldata });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  const spaceIdHex = (await publicClient.readContract({
    address: TESTNET.SPACE_REGISTRY_ADDRESS,
    abi: SpaceRegistryAbi,
    functionName: "addressToSpaceId",
    args: [address as `0x${string}`],
  })) as Hex;

  return spaceIdHex.slice(2, 34).toLowerCase();
}

// ─── Publish helper ───────────────────────────────────────────────────────────

export async function publishOps(config: PublishConfig): Promise<PublishResult> {
  const { ops, editName, privateKey, useSmartAccount = true, network = "TESTNET" } = config;

  try {
    const walletClient = useSmartAccount
      ? await getSmartAccountWalletClient({ privateKey })
      : await getWalletClient({ privateKey });

    const address = walletClient.account!.address;
    const spaceId = config.spaceId ?? (await ensurePersonalSpace(address, walletClient as any));

    const spaceData = await gql(
      `{ space(id: "${spaceId}") { type address membersList { memberSpaceId } editorsList { memberSpaceId } } }`,
      undefined,
      network
    );

    if (!spaceData.space) throw new Error(`Space ${spaceId} not found`);

    const publicClient = createGeoPublicClient();
    const { type: spaceType, address: daoAddress } = spaceData.space;
    let to: `0x${string}`, calldata: `0x${string}`, cid: string, editId: string;

    if (spaceType === "PERSONAL") {
      // FIX (Issue #5 + v0.13.1 breaking change):
      // v0.13.1 changed personalSpace.publishEdit to expect the personal space ID
      // as author (Person Entity ID / UUID), not the wallet address.
      const r = await personalSpace.publishEdit({
        name: editName,
        spaceId,
        ops,
        author: spaceId,          // v0.13.1: personal space ID, not wallet address
        network: network as "TESTNET",
      });
      ({ cid, editId, to, calldata } = r);
    } else {
      const psd = await gql(
        `{ spaces(filter: { address: { is: "${address}" } }) { id type } }`,
        undefined,
        network
      );
      const callerSpace = psd.spaces?.find((s: any) => s.type === "PERSONAL");
      if (!callerSpace) throw new Error(`No personal space found for ${address}`);

      const callerSpaceId: string = callerSpace.id;
      const members = [...(spaceData.space.membersList ?? []), ...(spaceData.space.editorsList ?? [])];
      if (!members.some((m: any) => m.memberSpaceId === callerSpaceId))
        throw new Error(`Space ${callerSpaceId} is not a member/editor of ${spaceId}`);

      // FIX (Issue #5):
      // Original code passed callerSpaceId as author (wrong).
      // v0.7.0 expected wallet address; v0.13.1 expects Person Entity ID (UUID).
      // callerSpaceId is a UUID — it IS the proposer's person entity on Geo.
      const r = await daoSpace.proposeEdit({
        name: editName,
        ops,
        author: callerSpaceId,                              // person entity ID (space UUID)
        network: network as "TESTNET",
        callerSpaceId: `0x${callerSpaceId}` as `0x${string}`,
        daoSpaceId: `0x${spaceId}` as `0x${string}`,
        daoSpaceAddress: daoAddress as `0x${string}`,
      });
      ({ cid, editId, to, calldata } = r);
    }

    const txHash = await (walletClient as any).sendTransaction({ to, data: calldata });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return { success: true, editId, cid, transactionHash: txHash, spaceId };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
