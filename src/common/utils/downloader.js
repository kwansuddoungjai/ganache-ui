const { Extract } = require("unzip-stream");
const { get } = require("follow-redirects/https");
const { join, parse, resolve } = require("path");
const { existsSync, createWriteStream, move, remove } = require("fs-extra");
const patchUnzipStream = require("./patch-unzip-stream");
const URL = require("url");
const temp = require("temp");
const noop = () => {};

function parseUrl(urlString){
  const parsed = URL.parse(urlString);
  return parse(parsed.pathname);
}

/**
 * Moves a folder immediately then deletes it in the background.
 * @param {string} path 
 * @param {string} (optional) suffix 
 */
function moveRemove(path, suffix) {
  const tmpDest = temp.path({suffix});
  // move it first
  const pendingMove = move(path, tmpDest).catch(console.error);
  // then delete it (fire and forget)
  pendingMove.then(() => remove(tmpDest).catch(console.error));
  return pendingMove;
}

class Downloader {
  constructor(saveLocation = "../../../dist/extras/") {
    this.saveLocation = resolve(__dirname, saveLocation);
  }

  /**
   * Downloads the resource to the saveLocation, using the file
   * @param {string} url The URL of the resource to download
   */
  async download(url, force = false) {
    const parsedUri = parseUrl(url);
    const ext = parsedUri.ext;
    const isZip = ext.toLowerCase() === ".zip";
    const dest = join(this.saveLocation, isZip ? parsedUri.name : parsedUri.base);
    // if the file/folder already exists don't download it again unless we are `force`d to
    const exists = existsSync(dest);
    let pendingMove;
    if (exists) {
      if (!force) {
        return Promise.resolve(dest);
      } else {
        pendingMove = moveRemove(dest, ext);
      }
    } else {
      pendingMove = Promise.resolve();
    }

    const fn = isZip ? this.unzip : this.save;
    return new Promise((resolve, reject) => {
      get(url, response => {
        if (response.statusCode !== 200) {
          return reject("Response status was " + response.statusCode);
        }

        const tmpDest = dest + ".downloading";
        // if there is already a `.downloading` file, we need to get rid of it first
        moveRemove(tmpDest, ext).catch(noop)
          // save our stream as .downloading
          .then(() => fn(response, tmpDest))
          // then move it to its final destination when completely downloaded
          .then(() => pendingMove.then(() => move(tmpDest, dest)))
          .then(() => resolve(dest))
          .catch(reject);
      }).on("error", err => {
        // if anything failed along the way, delete it all
        remove(dest, noop);
        reject(err);
      });
    });
  }

  /**
   * Saves the streamed file to the destination
   * @param {http.IncomingMessage} stream 
   * @param {string} dest 
   */
  async save(stream, dest) {
    const file = createWriteStream(dest, { mode: 0o755 });
    stream.pipe(file);
    return new Promise((resolve, reject) => {
      file.on("finish", () => {
        file.close(resolve);
      }).on("error", reject);
    });
  }

  /**
   * Unzips the stream to the path
   * @param {http.IncomingMessage} stream 
   * @param {string} path 
   */
  async unzip(stream, path) {
    return new Promise((resolve, reject) => {
      const extractor = new Extract({ path });
      patchUnzipStream(extractor);
      stream.pipe(extractor)
        .on("close", resolve)
        .on("error", reject);
    });
  }
  async downloadAll(urls, force) {
    return Promise.all(urls.map((url) => {
      return this.download(url, force);
    }));
  }
}

module.exports = Downloader;
