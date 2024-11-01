// import { isVideo } from '../lib/extension.js'
import { delay } from '../lib/promises.js';
import StaticResponse from './static.js';
import { getMagnetLink } from '../lib/magnetHelper.js';
import { Type } from '../lib/types.js';
import { decode } from 'magnet-uri';
// import { sameFilename, streamFilename } from './mochHelper.js'

import PremiumizeClient from 'premiumize-api';
import magnet from 'magnet-uri';
// import { Type } from '../lib/types.js'
import { isVideo, isArchive } from '../lib/extension.js';
// import StaticResponse from './static.js'
import {
  BadTokenError,
  chunkArray,
  sameFilename,
  streamFilename
} from './mochHelper.js';

const KEY = 'torbox';
const API_BASE = 'https://api.torbox.app';
const API_VERSION = 'v1';

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
  //   console.log(streams);
  const apiUrl = `${API_BASE}/${API_VERSION}/api/torrents/checkcached?hash={{torrent_hash}}&format=list&list_files=true`;
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
      //   console.log('resolve first promise error: ', error);
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
  const torrent = await _createOrFindTorrent(apiKey, infoHash);
  //   console.log('_resolve', torrent);
  if (torrent && statusReady(torrent)) {
    return _getCachedLink(apiKey, infoHash, cachedEntryInfo);
  } else if (torrent && statusDownloading(torrent)) {
    console.log(`Downloading to your Torbox ${infoHash}...`);
    return StaticResponse.DOWNLOADING;
  } else if (torrent && statusError(torrent.status)) {
    console.log(`Retrying downloading to your Torbox ${infoHash}...`);
    return _retryCreateTorrent(apiKey, infoHash, cachedEntryInfo, fileIndex);
  }
  return Promise.reject(
    `Failed Torbox adding torrent ${JSON.stringify(torrent)}`
  );
}

async function _getCachedLink(apiKey, infoHash, encodedFileName) {
  //   console.log('getting cached link for torrent: ', infoHash, encodedFileName);
  const apiUrl = `${API_BASE}/${API_VERSION}/api/torrents/checkcached?hash=${infoHash}&format=list&list_files=true`;
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
  //   console.log('resJson: ', resJson);
  if (!resJson?.data) return Promise.reject('No cached entry found');
  const torrent = await _createOrFindTorrent(apiKey, infoHash);
  //   console.log(torrent);
  //   console.log('torrent: ', torrent, torrent?.files);
  //   console.log('filename: ', encodedFileName, torrent.files.length);
  const fileId = torrent.files.find(
    (file) => file.short_name === encodedFileName
  )?.id;

  const getDownloadLinkApi = `${API_BASE}/${API_VERSION}/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${fileId}&zip_link=false`;
  const linkRes = await fetch(getDownloadLinkApi).then((res) => res.json());
  //   console.log(linkRes?.data);
  return linkRes?.data;
}

async function _createOrFindTorrent(apiKey, infoHash) {
  const returnData = await _findTorrent(apiKey, infoHash).catch(() => {
    // console.log('could not find the torrent in your torbox, adding one');
    return _createTorrent(apiKey, infoHash);
  });
  //   console.log('create or find ', returnData?.files?.length);
  return returnData;
}

async function _findTorrent(apiKey, infoHash) {
  const endpoint = `${API_BASE}/${API_VERSION}/api/torrents/mylist?bypass_cache=true`;
  const torrents = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  })
    .then((response) => response.json())
    .catch((error) => console.log(error));
  //   console.log('finding torrent in my list');
  //   console.log('find torrents: (my list) ', torrents);
  const foundTorrents = torrents?.data.filter(
    (torrent) => torrent.hash === infoHash
  );
  //   console.log('found torrent: ', foundTorrents.length);
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
  //   console.log('creating torrent with infohash:', infoHash);
  const magnetLink = await getMagnetLink(infoHash);
  const data = new URLSearchParams();
  data.append('magnet', magnetLink);
  const endpoint = `${API_BASE}/${API_VERSION}/api/torrents/createtorrent`;
  const createTorrent = fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    method: 'post',
    body: data
  });
  return createTorrent.then(() => _findTorrent(apiKey, infoHash));
}

async function _retryCreateTorrent(
  apiKey,
  infoHash,
  encodedFileName,
  fileIndex
) {
  const newTorrent = await _createTorrent(apiKey, infoHash).then(() =>
    _findTorrent(apiKey, infoHash)
  );
  return newTorrent && statusReady(newTorrent.status)
    ? _getCachedLink(apiKey, infoHash, encodedFileName, fileIndex)
    : StaticResponse.FAILED_DOWNLOAD;
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

function statusDownloading(torrent) {
  return !torrent?.download_finished;
}

function statusReady(torrent) {
  return torrent?.download_finished;
}

async function getDefaultOptions(ip) {
  return { timeout: 5000 };
}
