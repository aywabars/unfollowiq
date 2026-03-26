const db = require('./database');
const instagram = require('./instagram');

// In-memory tracking of running jobs
const activeJobs = new Map();

// ===== ACCOUNT TIER PROFILES =====
// Based on Instagram's known rate limits by account age/size
const ACCOUNT_TIERS = {
  new: {
    label: 'New (0-3 months, <1K followers)',
    dailyLimit: 80,
    hourlyLimit: 15,
    minDelay: 60,     // seconds
    maxDelay: 120,    // seconds
    avgDelay: 80,
    cooldownHours: 10,
  },
  growing: {
    label: 'Growing (3-12 months, 1K-5K followers)',
    dailyLimit: 150,
    hourlyLimit: 40,
    minDelay: 35,
    maxDelay: 90,
    avgDelay: 55,
    cooldownHours: 8,
  },
  established: {
    label: 'Established (1+ year, 5K-50K followers)',
    dailyLimit: 200,
    hourlyLimit: 60,
    minDelay: 25,
    maxDelay: 75,
    avgDelay: 45,
    cooldownHours: 6,
  },
  large: {
    label: 'Large (2+ years, 50K+ followers)',
    dailyLimit: 300,
    hourlyLimit: 80,
    minDelay: 20,
    maxDelay: 60,
    avgDelay: 35,
    cooldownHours: 5,
  }
};

// ===== HUMAN-LIKE DELAY GENERATOR =====
// Instead of fixed delay + jitter, this simulates real human behavior:
// - Most delays cluster around a "thinking" time (40-60s)
// - Occasionally fast (just scrolled past, instant decision) ~20-30s
// - Occasionally slow (checked their profile first) ~80-120s
// - Very rarely a long pause (got distracted, checked DMs) ~120-180s
function humanDelay(tier) {
  const r = Math.random();
  let base;

  if (r < 0.05) {
    // 5% chance: long pause (got distracted)
    base = tier.maxDelay + Math.random() * 60;
  } else if (r < 0.15) {
    // 10% chance: slow (checked their profile)
    base = tier.maxDelay * 0.8 + Math.random() * (tier.maxDelay * 0.4);
  } else if (r < 0.30) {
    // 15% chance: quick decision
    base = tier.minDelay + Math.random() * (tier.minDelay * 0.5);
  } else {
    // 70% chance: normal "thinking" pace
    const mid = (tier.minDelay + tier.maxDelay) / 2;
    const spread = (tier.maxDelay - tier.minDelay) * 0.3;
    // Gaussian-ish distribution around the middle
    const u1 = Math.random(), u2 = Math.random();
    const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    base = mid + gaussian * spread;
  }

  // Clamp to tier bounds (with a little headroom for the "distracted" pauses)
  base = Math.max(tier.minDelay, Math.min(base, tier.maxDelay + 90));

  return Math.round(base * 1000); // return ms
}

// ===== TIME ESTIMATE =====
function estimateCompletion(count, tier) {
  const dailyLimit = tier.dailyLimit;
  const avgDelaySeconds = tier.avgDelay;
  const cooldownHours = tier.cooldownHours;

  const fullDays = Math.floor(count / dailyLimit);
  const remainder = count % dailyLimit;

  // Active time per day
  const activeHoursPerDay = (dailyLimit * avgDelaySeconds) / 3600;
  const totalActiveHours = (count * avgDelaySeconds) / 3600;

  // Total calendar time including cooldowns
  const totalDays = fullDays + (remainder > 0 ? 1 : 0);
  const totalCalendarHours = (fullDays * (activeHoursPerDay + cooldownHours)) + (remainder * avgDelaySeconds / 3600);

  return {
    totalDays,
    totalActiveHours: Math.round(totalActiveHours * 10) / 10,
    totalCalendarHours: Math.round(totalCalendarHours * 10) / 10,
    dailyLimit,
    activeHoursPerDay: Math.round(activeHoursPerDay * 10) / 10,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(userId, jobId, message, level = 'info') {
  db.addLog(userId, jobId, message, level);
  console.log(`[Job ${jobId?.slice(0, 8)}] [${level}] ${message}`);
}

module.exports = {
  ACCOUNT_TIERS,
  estimateCompletion,

  init() {
    console.log('[JobQueue] Initialized');
  },

  // ===== SCAN JOB =====
  startScan(userId, session) {
    const existing = db.getActiveJob(userId);
    if (existing) throw new Error('A job is already running. Stop it first.');

    const jobId = db.createJob(userId, 'scan', 0);
    log(userId, jobId, 'Scan started', 'info');

    (async () => {
      try {
        let igUserId = session.ig_user_id;
        if (!igUserId) {
          const verify = await instagram.verifySession(session);
          if (!verify.valid) {
            log(userId, jobId, 'Session invalid. Please reconnect Instagram.', 'error');
            db.updateJob(jobId, { status: 'failed' });
            return;
          }
          igUserId = verify.userId;
          db.saveInstagramSession(userId, {
            sessionId: session.session_id,
            csrfToken: session.csrf_token,
            igUserId: String(igUserId),
            username: verify.username
          });
        }

        log(userId, jobId, 'Fetching following list...', 'info');
        const following = await instagram.fetchList('following', igUserId, session, (msg, level) => {
          log(userId, jobId, msg, level);
        });
        db.saveFollowersData(userId, following, 'following');
        log(userId, jobId, `Following: ${following.length} accounts`, 'success');

        log(userId, jobId, 'Fetching followers list...', 'info');
        const followers = await instagram.fetchList('followers', igUserId, session, (msg, level) => {
          log(userId, jobId, msg, level);
        });
        db.saveFollowersData(userId, followers, 'followers');
        log(userId, jobId, `Followers: ${followers.length} accounts`, 'success');

        const followerPks = new Set(followers.map(u => u.pk));
        const nonFollowers = following.filter(u => !followerPks.has(u.pk));
        const mutualCount = following.length - nonFollowers.length;

        db.saveNonFollowers(userId, nonFollowers);
        db.updateJob(jobId, {
          status: 'completed',
          total_count: nonFollowers.length,
          processed_count: following.length + followers.length,
          completed_at: new Date().toISOString()
        });

        log(userId, jobId, `Scan complete: ${nonFollowers.length} non-followers, ${mutualCount} mutual`, 'success');
      } catch (err) {
        log(userId, jobId, `Scan failed: ${err.message}`, 'error');
        db.updateJob(jobId, { status: 'failed' });
      }
    })();

    return jobId;
  },

  // ===== UNFOLLOW JOB =====
  startUnfollow(userId, session, whitelist = [], tierKey = 'growing') {
    const existing = db.getActiveJob(userId);
    if (existing) throw new Error('A job is already running. Stop it first.');

    const nonFollowers = db.getNonFollowers(userId).filter(u => u.status === 'pending');
    if (!nonFollowers.length) throw new Error('No pending non-followers. Run a scan first.');

    const tier = ACCOUNT_TIERS[tierKey] || ACCOUNT_TIERS.growing;
    const whitelistSet = new Set(whitelist.map(w => w.toLowerCase().trim()));
    const targets = nonFollowers.filter(u => !whitelistSet.has(u.ig_username.toLowerCase()));

    const estimate = estimateCompletion(targets.length, tier);
    const jobId = db.createJob(userId, 'unfollow', targets.length);

    log(userId, jobId, `Unfollow job started: ${targets.length} targets`, 'info');
    log(userId, jobId, `Account tier: ${tier.label}`, 'info');
    log(userId, jobId, `Daily limit: ${tier.dailyLimit} | Delay range: ${tier.minDelay}-${tier.maxDelay}s (human-like)`, 'info');
    log(userId, jobId, `Estimated: ${estimate.totalDays} days (${estimate.totalActiveHours}h active, ${estimate.totalCalendarHours}h total)`, 'info');

    const jobState = { stop: false };
    activeJobs.set(userId, jobState);

    (async () => {
      let totalUnfollowed = 0;
      let totalErrors = 0;
      let dailyCount = 0;
      let dayNum = 1;
      let idx = 0;

      try {
        while (idx < targets.length && !jobState.stop) {

          // Daily session start
          log(userId, jobId, `--- Day ${dayNum}: starting (limit: ${tier.dailyLimit}/day) ---`, 'info');
          dailyCount = 0;

          while (idx < targets.length && dailyCount < tier.dailyLimit && !jobState.stop) {
            const target = targets[idx];

            try {
              log(userId, jobId, `[${idx + 1}/${targets.length}] Unfollowing @${target.ig_username}...`, 'info');
              const result = await instagram.unfollowUser(target.ig_pk, session);

              if (result.ok) {
                db.updateNonFollowerStatus(target.id, 'unfollowed');
                totalUnfollowed++;
                dailyCount++;
                log(userId, jobId, `Unfollowed @${target.ig_username} (${totalUnfollowed} total, ${dailyCount} today)`, 'success');
              } else if (result.status === 429) {
                log(userId, jobId, 'Rate limited! Pausing 15 minutes...', 'warn');
                db.updateJob(jobId, { processed_count: idx, unfollowed_count: totalUnfollowed, error_count: totalErrors });
                for (let s = 0; s < 900 && !jobState.stop; s++) await sleep(1000);
                continue; // retry same target
              } else {
                db.updateNonFollowerStatus(target.id, 'error');
                totalErrors++;
                log(userId, jobId, `Error for @${target.ig_username}: HTTP ${result.status}`, 'error');
              }
            } catch (err) {
              db.updateNonFollowerStatus(target.id, 'error');
              totalErrors++;
              log(userId, jobId, `Network error for @${target.ig_username}: ${err.message}`, 'error');
            }

            idx++;

            db.updateJob(jobId, {
              processed_count: idx,
              unfollowed_count: totalUnfollowed,
              error_count: totalErrors
            });

            // Human-like delay before next unfollow
            if (idx < targets.length && dailyCount < tier.dailyLimit && !jobState.stop) {
              const delay = humanDelay(tier);
              const delaySec = Math.round(delay / 1000);
              log(userId, jobId, `Waiting ${delaySec}s...`, 'info');
              for (let s = 0; s < delaySec && !jobState.stop; s++) await sleep(1000);
            }
          }

          // Daily limit reached â cooldown
          if (idx < targets.length && !jobState.stop) {
            const coolSec = tier.cooldownHours * 3600;
            log(userId, jobId, `Day ${dayNum} done: ${dailyCount} unfollowed today. Resting ${tier.cooldownHours} hours...`, 'warn');
            for (let s = 0; s < coolSec && !jobState.stop; s++) {
              await sleep(1000);
            }
            dayNum++;
          }
        }

        const finalStatus = jobState.stop ? 'stopped' : 'completed';
        db.updateJob(jobId, {
          status: finalStatus,
          processed_count: idx,
          unfollowed_count: totalUnfollowed,
          error_count: totalErrors,
          completed_at: new Date().toISOString()
        });
        log(userId, jobId, `Job ${finalStatus}. Unfollowed: ${totalUnfollowed}, Errors: ${totalErrors}`, 'success');
      } catch (err) {
        log(userId, jobId, `Job crashed: ${err.message}`, 'error');
        db.updateJob(jobId, { status: 'failed', unfollowed_count: totalUnfollowed, error_count: totalErrors });
      }

      activeJobs.delete(userId);
    })();

    return jobId;
  },

  stopJob(userId) {
    const job = activeJobs.get(userId);
    if (job) {
      job.stop = true;
      log(userId, null, 'Stop requested', 'warn');
    }
    const activeJob = db.getActiveJob(userId);
    if (activeJob) {
      db.updateJob(activeJob.id, { status: 'stopping' });
    }
  }
};
