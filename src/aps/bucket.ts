import axios from 'axios';
import { getApsToken } from './auth';
import { withRetry } from '../utils/retry';

const APS_OSS_URL = 'https://developer.api.autodesk.com/oss/v2';

export interface BucketObject {
  bucketKey: string;
  objectKey: string;
  objectId: string;
  sha1: string;
  size: number;
  location: string;
}

export interface ListObjectsResponse {
  items: BucketObject[];
  next?: string;
}

export interface BucketInfo {
  bucketKey: string;
  bucketOwner: string;
  createdDate: number;
  permissions: Array<{ authId: string; access: string }>;
  policyKey: string;
}

export async function listBuckets(): Promise<BucketInfo[]> {
  const token = await getApsToken();

  const response = await withRetry(async () => {
    return axios.get<{ items: BucketInfo[] }>(`${APS_OSS_URL}/buckets`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      params: {
        region: 'US',
        limit: 100,
      },
    });
  });

  return response.data.items || [];
}

export async function listBucketObjects(
  bucketKey: string,
  options: { limit?: number; startAt?: string; beginsWith?: string } = {}
): Promise<ListObjectsResponse> {
  const token = await getApsToken();
  const { limit = 100, startAt, beginsWith } = options;

  const params: Record<string, string | number> = { limit };
  if (startAt) params.startAt = startAt;
  if (beginsWith) params.beginsWith = beginsWith;

  const response = await withRetry(async () => {
    return axios.get<ListObjectsResponse>(
      `${APS_OSS_URL}/buckets/${encodeURIComponent(bucketKey)}/objects`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params,
      }
    );
  });

  return response.data;
}

export async function getAllBucketObjects(bucketKey: string): Promise<BucketObject[]> {
  const allObjects: BucketObject[] = [];
  let startAt: string | undefined;

  do {
    const response = await listBucketObjects(bucketKey, { limit: 100, startAt });
    allObjects.push(...response.items);

    if (response.next) {
      const url = new URL(response.next);
      startAt = url.searchParams.get('startAt') || undefined;
    } else {
      startAt = undefined;
    }
  } while (startAt);

  return allObjects;
}

export function getObjectUrn(objectId: string): string {
  return Buffer.from(objectId).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface ObjectDetails {
  bucketKey: string;
  objectKey: string;
  objectId: string;
  sha1: string;
  size: number;
  contentType: string;
  location: string;
}

export async function getObjectDetails(
  bucketKey: string,
  objectKey: string
): Promise<ObjectDetails> {
  const token = await getApsToken();

  const response = await withRetry(async () => {
    return axios.get<ObjectDetails>(
      `${APS_OSS_URL}/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}/details`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
  });

  return response.data;
}
