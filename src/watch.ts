import type { QueueObject } from 'async';
import { queue } from 'async';
import type { EventEmitter } from 'bunyan';
import chalk from 'chalk';
import type { DatabaseChangesResultItem } from 'nano';

import type { FinalPkg } from './@types/pkg';
import type { StateManager } from './StateManager';
import type { AlgoliaStore } from './algolia';
import { config } from './config';
import { DeletedError } from './errors';
import { formatPkg } from './formatPkg';
import * as npm from './npm';
import { isFailure } from './npm/types';
import { saveDoc } from './saveDocs';
import { datadog } from './utils/datadog';
import { log } from './utils/log';
import * as sentry from './utils/sentry';
import { backoff } from './utils/wait';

type ChangeJob = {
  change: DatabaseChangesResultItem;
  retry: number;
  ignoreSeq: boolean;
};

export class Watch {
  stateManager: StateManager;
  algoliaStore: AlgoliaStore;
  skipped = new Map<string, ChangeJob>();
  // Cached npmInfo.seq
  totalSequence: number = 0;
  changesConsumer: QueueObject<ChangeJob> | undefined;
  pkgsLastUpdate = new Map<string, number>();

  changesReader: EventEmitter | undefined;

  constructor(stateManager: StateManager, algoliaStore: AlgoliaStore) {
    this.stateManager = stateManager;
    this.algoliaStore = algoliaStore;
  }

  /**
   * Run watch.
   *
   *  --- Watch ?
   *   Watch is "Long Polled. This mode is not paginated and the event system in CouchDB send
   *     events as they arrive, which is super cool and reactive.
   *   One gotcha those events arrive at the same rate wether you are watching the last seq or not.
   *
   *   Example:
   *    listener A - up to date
   *    listener B - few sequences behind.
   *
   *    Package C is updated.
   *
   *    Listener A receive update C
   *    listener B receive update N.
   *
   *    Listener A is up to date again
   *    listener B is still few sequences behind and will not receive any other event
   *      until an other package is updated.
   *      It will never be up to date because he receive event at the same pace
   *      as they arrive in listener A, even if it's not the same package.
   *
   * --- Retry strategy.
   *  Each packages update needs to be processed in order so there is a first naive strategy that will block the queue.
   *  It will retry the same package after an exponential backoff, N times.
   *
   *  After N times, this update will be discarded in the this.skipped
   *  This Map will be regularly reprocessed to avoid losing jobs.
   *  This is an in-memory only retry, if the process is stopped, skipped job are lost.
   */
  async run(): Promise<void> {
    log.info('-----');
    log.info('🚀  Watch: starting');
    log.info('-----');

    await this.stateManager.save({
      stage: 'watch',
    });

    this.changesConsumer = this.createChangeConsumer();

    setInterval(async () => {
      this.totalSequence = (await npm.db.info()).update_seq;
    }, 5000);

    this.checkSkipped();

    // TO DO: uncomment this
    // Most packages don't have enough info to enable refresh for the moment
    // this.checkToRefresh();

    await this.launchChangeReader();
  }

  async stop(): Promise<void> {
    log.info('Stopping Watch...');

    try {
      npm.db.changesReader.stop();
      await this.changesConsumer?.drain();
    } catch (err) {
      sentry.report(err);
    }
    this.changesReader?.removeAllListeners();

    log.info('Stopped Watch gracefully', {
      queued: this.changesConsumer?.length() || 0,
      processing: this.changesConsumer?.running() || 0,
    });
  }

  async launchChangeReader(): Promise<void> {
    const { seq } = await this.stateManager.get();

    log.info(`listening from ${seq}...`);

    const reader = npm.db.changesReader.start({
      includeDocs: false,
      batchSize: 1,
      since: String(seq),
    });
    reader
      .on('change', (change) => {
        this.changesConsumer!.push({ change, retry: 0, ignoreSeq: false });
        if (change.id) {
          this.pkgsLastUpdate.set(change.id, Date.now());
        }

        // on:change will not wait for us to process to trigger again
        // So we need to control the fetch manually otherwise it will fetch thousand/millions of update in advance
        if (this.changesConsumer!.length() > config.watchMaxPrefetch) {
          npm.db.changesReader.pause();
        }
      })
      .on('error', (err) => {
        sentry.report(err);
      });

    this.changesConsumer!.saturated(() => {
      if (this.changesConsumer!.length() < config.watchMinUnpause) {
        npm.db.changesReader.resume();
      }
    });

    this.changesReader = reader;
  }

  /**
   * Regularly try to reprocess skipped packages.
   */
  checkSkipped(): void {
    log.info('Checking skipped jobs (', this.skipped.size, ')');
    datadog.increment('packages.skipped', this.skipped.size);

    if (this.skipped.size > 0) {
      const clone = this.skipped.values();
      this.skipped.clear();

      for (const job of clone) {
        this.changesConsumer?.unshift({ ...job, retry: 0, ignoreSeq: true });
      }
    }

    setTimeout(() => {
      this.checkSkipped();
    }, config.retrySkipped);
  }

  /**
   * Regularly try to refresh packages informations.
   * Mostly here for time based data: download stats, popularity, etc...&.
   */
  async checkToRefresh(): Promise<void> {
    log.info('Checking refresh jobs');

    // schedule next iteration
    setTimeout(() => {
      this.checkToRefresh();
    }, config.refreshPeriod);

    // We list all values in facet and pick the oldest (hopefully the oldest is in the list)
    const res = await this.algoliaStore.mainIndex.search('', {
      facets: ['_searchInternal.expiresAt'],
      hitsPerPage: 0,
      sortFacetValuesBy: 'alpha',
    });
    if (!res.facets) {
      log.error('Wrong results from Algolia');
      return;
    }

    const list = Object.keys(res.facets['_searchInternal.expiresAt']!).sort();
    log.info(' > Found', list.length, 'expiration values');
    if (list.length <= 0) {
      return;
    }

    const pick = list.shift()!;
    const expiresAt = new Date(parseInt(pick, 10));
    if (expiresAt.getTime() > Date.now()) {
      log.info(' > Oldest date is in the future');
      return;
    }
    log.info(' > Picked the oldest', expiresAt.toISOString());

    // Retrieve some packages to update, not too much to avoid flooding the queue
    const pkgs = await this.algoliaStore.mainIndex.search<FinalPkg>('', {
      facetFilters: [`_searchInternal.expiresAt:${pick}`],
      facets: ['_searchInternal.expiresAt'],
      hitsPerPage: 20,
    });
    log.info(' > Found', pkgs.hits.length, 'expired packages');

    const pushed: string[] = [];
    for (const pkg of pkgs.hits) {
      if (!pkg.rev) {
        continue;
      }
      const lastUpdate = this.pkgsLastUpdate.get(pkg.objectID);
      if (lastUpdate && lastUpdate > pkg.modified) {
        log.info(
          'Skipping pkg older than what we have in memory',
          pkg.objectID,
          pkg.modified,
          lastUpdate
        );
        continue;
      }

      pushed.push(pkg.objectID);

      // Due to the event loop, there is a miniscule chance that an event for the same pkg come at the same time.
      this.changesConsumer?.unshift({
        change: {
          id: pkg.objectID,
          changes: [{ rev: pkg.rev }],
          seq: -1,
          deleted: false,
        },
        retry: 0,
        ignoreSeq: true,
      });
    }

    log.info(' > Pushed', pushed);
  }

  /**
   * Process changes in order.
   */
  async loop(job: ChangeJob): Promise<void> {
    const { change } = job;
    datadog.increment('packages');

    if (!change.id) {
      // Can happen when NPM send an empty line (for example the hearthbeat) 🤷🏻‍
      log.error('Got a document without name', change);
      return;
    }

    if (job.retry > 0) {
      await backoff(job.retry, config.retryBackoffPow);
    }

    if (change.deleted) {
      // changesConsumer deletes the package directly in the index
      throw new DeletedError();
    }
    if (change.changes.length <= 0) {
      log.error('Document without change');
      return;
    }

    const res = await npm.getDoc(change.id, change.changes[0]!.rev);

    if (isFailure(res)) {
      throw new Error(res.error);
    }

    const formatted = formatPkg(res);
    if (!formatted) {
      return;
    }

    await saveDoc({ formatted, index: this.algoliaStore.mainIndex });
  }

  /**
   * Log our process through watch.
   *
   */
  logProgress(seq: number): void {
    datadog.gauge('watch.sequence.total', this.totalSequence);
    datadog.gauge('watch.sequence.current', seq);

    log.info(
      chalk.dim.italic
        .white`[progress] Synced %d/%d changes (%s%) (%s remaining) (%s in memory)`,
      seq,
      this.totalSequence,
      ((Math.max(seq, 1) / this.totalSequence) * 100).toFixed(2),
      this.totalSequence - seq,
      this.changesConsumer!.length()
    );
  }

  /**
   * Queue is ensuring we are processing changes ordered
   * This also means we can not process more than 1 at the same time.
   *
   * --- Why ?
   *   CouchDB send changes in an ordered fashion
   *     Event A update package C
   *     Event B delete package C.
   *
   *     If the events are not processed in the same order, you can have a broken state.
   *
   */
  createChangeConsumer(): QueueObject<ChangeJob> {
    return queue<ChangeJob>(async (job) => {
      const start = Date.now();

      const ignoreSeq = job.retry > 0 || job.ignoreSeq;
      const { seq, id } = job.change;
      log.info(`Start:`, id);

      if (this.skipped.has(id)) {
        // We received a new update for a package that failed before
        // That means the previous update is no longer relevant
        this.skipped.delete(id);
      }

      try {
        await this.loop(job);
        if (!ignoreSeq) {
          await this.stateManager.save({
            seq,
          });
        }
        log.info(`Done:`, id);
      } catch (err) {
        // this error can be thrown by us or by nano if:
        // - we received a change that is not marked as "deleted"
        // - and the package has since been deleted
        if (err instanceof DeletedError) {
          this.algoliaStore.mainIndex.deleteObject(id);
          log.info(`deleted`, id);
          return;
        }

        // eslint-disable-next-line no-param-reassign
        job.retry += 1;
        sentry.report(err);

        if (job.retry <= config.retryMax) {
          this.changesConsumer!.unshift(job);
        } else {
          log.error('Job has been retried too many times, skipping');
          datadog.increment('packages.failed');
          this.skipped.set(id, job);

          // Store in lost index
          try {
            await this.algoliaStore.mainLostIndex.saveObject({
              objectID: job.change.id,
              err: err instanceof Error ? err.toString() : err,
              date: start,
              job,
            });
          } catch (err2) {
            log.error(new Error('Error during lost'), err2);
          }
        }
      } finally {
        if (!ignoreSeq) {
          this.logProgress(seq);
        }
        datadog.timing('watch.loop', Date.now() - start);
      }
    }, 1);
  }
}
