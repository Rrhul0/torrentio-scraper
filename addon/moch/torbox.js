import StaticResponse from './static.js';
import { getMagnetLink } from '../lib/magnetHelper.js';
import { Type } from '../lib/types.js';

import PremiumizeClient from 'premiumize-api';
import magnet from 'magnet-uri';
import { isVideo } from '../lib/extension.js';
import {
  BadTokenError,
  chunkArray,
  streamFilename
} from './mochHelper.js';

const KEY = 'torbox';
const API_BASE = 'https://api.torbox.app';
const API_VERSION = 'v1';
const API_BASE_TORRENT = `${API_BASE}/${API_VERSION}/api/torrents`;

export async function getCachedStreams(streams, apiKey) {
  return Promise.all(
    chunkArray(streams, 100).map((chunkedStreams) =>
      _getCachedStreams(apiKey, chunkedStreams)
    )
  )
    .then((results) =>
      results.reduce((all, result) => Object.assign(all, result), {})
    )
    .catch((e) => console.log(e));
}

async function _getCachedStreams(apiKey, streams) {
  const apiUrl = `${API_BASE_TORRENT}/checkcached?hash={{torrent_hash}}&format=list&list_files=true`;
  const hashes = streams.map((stream) => stream.infoHash).join(',');
  const uri = apiUrl.replace('{{torrent_hash}}', hashes);
  return fetch(uri, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  })
    .then((response) => response.json())
    .catch((error) => {
      if (toCommonError(error)) {
        return Promise.reject(error);
      }
      console.warn('Failed Torbox cached torrent availability request:', error);
      return undefined;
    })
    .then((responseJson) => {
      const availableHashes = responseJson?.data?.map((data) => data.hash);
      const stNew = streams.reduce((mochStreams, stream, index) => {
        const filename = streamFilename(stream);
        mochStreams[`${stream.infoHash}@${stream.fileIdx}`] = {
          url: `${apiKey}/${stream.infoHash}/${filename}/${stream.fileIdx}`,
          cached: !!availableHashes?.includes(stream.infoHash)
        };
        return mochStreams;
      }, {});
      return stNew;
    });
}

export async function getCatalog(apiKey, offset = 0) {
  if (offset > 0) {
    return [];
  }
  const options = await getDefaultOptions();
  const PM = new PremiumizeClient(apiKey, options);
  return PM.folder
    .list()
    .then((response) => response.content)
    .then((torrents) =>
      (torrents || [])
        .filter((torrent) => torrent && torrent.type === 'folder')
        .map((torrent) => ({
          id: `${KEY}:${torrent.id}`,
          type: Type.OTHER,
          name: torrent.name
        }))
    );
}

export async function getItemMeta(itemId, apiKey, ip) {
  const options = await getDefaultOptions();
  const PM = new PremiumizeClient(apiKey, options);
  const rootFolder = await PM.folder.list(itemId, null);
  const infoHash = await _findInfoHash(PM, itemId);
  return getFolderContents(PM, itemId, ip).then((contents) => ({
    id: `${KEY}:${itemId}`,
    type: Type.OTHER,
    name: rootFolder.name,
    infoHash: infoHash,
    videos: contents.map((file, index) => ({
      id: `${KEY}:${file.id}:${index}`,
      title: file.name,
      released: new Date(file.created_at * 1000 - index).toISOString(),
      streams: [{ url: file.link || file.stream_link }]
    }))
  }));
}

async function getFolderContents(PM, itemId, ip, folderPrefix = '') {
  return PM.folder
    .list(itemId, null, ip)
    .then((response) => response.content)
    .then((contents) =>
      Promise.all(
        contents
          .filter((content) => content.type === 'folder')
          .map((content) =>
            getFolderContents(
              PM,
              content.id,
              ip,
              [folderPrefix, content.name].join('/')
            )
          )
      )
        .then((otherContents) =>
          otherContents.reduce((a, b) => a.concat(b), [])
        )
        .then((otherContents) =>
          contents
            .filter(
              (content) => content.type === 'file' && isVideo(content.name)
            )
            .map((content) => ({
              ...content,
              name: [folderPrefix, content.name].join('/')
            }))
            .concat(otherContents)
        )
    );
}

export async function resolve({ apiKey, infoHash, cachedEntryInfo }) {
  return _getCachedLink(apiKey, infoHash, cachedEntryInfo)
    .catch((error) => {
      console.log('error getting cached (first step)',error)
      // could not find torrent in cache
      return _resolve(apiKey, infoHash, cachedEntryInfo);
    })
    .catch((error) => {
      if (error?.message?.includes('Account not premium.')) {
        console.log(`Access denied to Torbox ${infoHash} [${fileIndex}]`);
        return StaticResponse.FAILED_ACCESS;
      }
      return Promise.reject(
        `Failed Torbox adding torrent resolve ${JSON.stringify(error)}`
      );
    });
}

async function _resolve(apiKey, infoHash, cachedEntryInfo) {
  // no check were found have to add and download the torrent
  // const torrent = await _createOrFindTorrent(apiKey, infoHash);
  const torrent = await _createTorrent(apiKey, infoHash);
  console.log(torrent)
  if (torrent && statusCachedFromAdding(torrent?.detail)) {
    // mostly will never go here
    return _getCachedLink(apiKey, infoHash, cachedEntryInfo);
  } else if (torrent && statusDownloadingFromAdding(torrent?.detail)) {
    console.log(`Downloading to your Torbox ${infoHash}...`);
    return StaticResponse.DOWNLOADING;
  } else if (torrent && statusQueuedFromAdding(torrent?.detail)) {
    console.log(`Queued to your Torbox ${infoHash}...`);
    return StaticResponse.QUEUED;
  } else if (torrent && statusCooldownFromAdding(torrent?.detail)) {
    console.log(`Torbox have cooldown ${infoHash}...`)
    return StaticResponse.COOLDOWN_LIMIT
  }
  // else if (torrent && statusError(torrent.status)) {
  //   console.log(`Retrying downloading to your Torbox ${infoHash}...`);
  //   return _retryCreateTorrent(apiKey, infoHash, cachedEntryInfo, fileIndex);
  // }
  return Promise.reject(
    `Failed Torbox adding torrent ${JSON.stringify(torrent)}`
  );
}

async function _getCachedLink(apiKey, infoHash, encodedFileName) {
  const apiUrl = `${API_BASE_TORRENT}/checkcached?hash=${infoHash}&format=list&list_files=true`;
  const resJson = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  })
    .then((response) => response.json())
    .catch((error) => {
      if (toCommonError(error)) {
        return Promise.reject(error);
      }
      console.warn('Failed Torbox cached torrent availability request:', error);
      return undefined;
    });
  if (!resJson?.data) return Promise.reject('No cached entry found');

  const torrent = await _createOrFindTorrent(apiKey, infoHash);
  const fileId = torrent.files.find(
    (file) => file.short_name === encodedFileName
  )?.id;

  const getDownloadLinkApi = `${API_BASE_TORRENT}/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${fileId}&zip_link=false`;
  const linkRes = await fetch(getDownloadLinkApi).then((res) => res.json());
  return linkRes?.data;
}

async function _createOrFindTorrent(apiKey, infoHash) {
  const returnData = await _findTorrent(apiKey, infoHash).catch(() => {
    return _createThenFind(apiKey, infoHash);
  });
  return returnData;
}

async function _findTorrent(apiKey, infoHash) {
  const endpoint = `${API_BASE_TORRENT}/mylist?bypass_cache=true`;
  const torrents = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  })
    .then((response) => response.json())
    .catch((error) => console.log(error));
  const foundTorrents = torrents?.data.filter(
    (torrent) => torrent.hash === infoHash
  );
  const nonFailedTorrent = foundTorrents.find(
    (torrent) => !statusError(torrent.statusCode)
  );
  const foundTorrent = nonFailedTorrent || foundTorrents[0];
  return foundTorrent || Promise.reject('No recent torrent found');
}

async function _findInfoHash(PM, itemId) {
  const torrents = await PM.transfer
    .list()
    .then((response) => response.transfers);
  const foundTorrent = torrents.find(
    (torrent) =>
      `${torrent.file_id}` === itemId || `${torrent.folder_id}` === itemId
  );
  return foundTorrent?.src
    ? magnet.decode(foundTorrent.src).infoHash
    : undefined;
}

async function _createTorrent(apiKey, infoHash) {
  const magnetLink = await getMagnetLink(infoHash);
  const data = new URLSearchParams();
  data.append('magnet', magnetLink);
  data.append('seed',3);
  data.append('allow_zip',false)
  const endpoint = `${API_BASE_TORRENT}/createtorrent`;
  const createTorrent = fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    method: 'post',
    body: data
  });
  return createTorrent.then((response) => response.json());
}

async function _createThenFind(apiKey,infoHash){
  return _createTorrent(apiKey,infoHash).then(()=>_findTorrent(apiKey,infoHash));
}


export function toCommonError(error) {
  if (error && error.message === 'Not logged in.') {
    return BadTokenError;
  }
  return undefined;
}

function statusError(status) {
  return ['deleted', 'error', 'timeout'].includes(status);
}

async function getDefaultOptions(ip) {
  return { timeout: 5000 };
}

function statusDownloadingFromAdding(detail=''){
  return detail.match(/Added/i);
}

function statusQueuedFromAdding(detail=''){
  return detail.match(/queued/i);
}

function statusCachedFromAdding(detail=''){
  return detail.match(/Cached/i);
}

function statusCooldownFromAdding(detail = '') {
  return detail.match(/cooldown/i)
}