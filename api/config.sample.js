var countlyConfig = {};

countlyConfig.mongodb = {
    host: 'localhost',
    db: 'countly',
    port: 27017,
    user: null,
    password: null
};

countlyConfig.api = {
    port: 3001,                                     // Port for API service
    dropDeviceIdBackwardsCompatibility: false,      // Controls how device ID is stored in database.
                                                    // In old versions it was stored as a hash of app ID & actual device ID.
                                                    // For new installations hashing is not required anymore.
    events: {
        log: false,                                 // Log all incoming events, see below
        logWhitelist: []
    },
    users: {
        dimensions: false,                          // User (device) dimensions, see below
        dimensionsWhitelist: []
    }
};

/* Event logging
 * If you plan to use Countly for more than app analytics you might need all events to be stored for future use.
 * Set countlyConfig.api.events to {log: true} to log all coming events in event_log* collections.
 * To whitelist logged events fill countlyConfig.events.logWhitelist array with keys of all events that need to be logged.
 * Empty or undefined logWhitelist with {log: true} means all events are to be stored.
 *
 * Note that besides standard parameters of event (key, count, sum, segmentation) 'id' parameter is also stored
 * as a collection primary key (_id in mongo).
 * Specify your ID of event (if any) in this parameter for later use. If no ID provided, Countly will generate it.
 *
 * Note that there is no corresponding /o method for event log. It's assumed that to read events you should use
 * direct database connection instead.
 */

//countlyConfig.api.events = {log: true, logWhitelist: ['event1', 'event2', 'event3']};


/* User dimensions
 * This feature enables tracking of ad campaigns performance, A/B testing and even enables basic cohort analysis.
 * User dimensions is effectively splitting ALL Countly metrics between dimensions.
 * You'll have one big number (as without user dimensions) and several segmented numbers for each Countly metric
 * like session counter and frequency, devices, carriers, etc. It's like event segmentation, but much cooler.
 *
 * To use user dimensions you need to specify 'dimensions' parameter like {a: 1, b: 'seg1', c: 'newsletter'}
 * with API request. There is no need to pass it with every request, it's stored in database on device level.
 * Whenever you need to change parameter, just pass changed dimensions, like {a: 2}, starting from this point
 * this user will be counted in new dimension.
 *
 * Note that when user (device) has 2 or more dimensions, Countly can store cartesian product of this dimensions' metrics.
 * This is required if you need to analyze intersections of different segments.
 * For example, if user has dimensions {a: 1, b: 2, c: 3}, Countly can store 7 different dimensional metrics (a; b; c; a,b;
 * a,c; b,c; a,b,c) for each metric: sessions, OS versions, etc. So you'll be able to get such metrics as
 * "Session number of devices with a = 1 AND b = 2" or "Event A number with event segmentation X for all devices
 * where campaign = 'newsletter' AND ab_test = 'A' AND signed_up = 'june2012'".
 *
 * All this goodness comes at price. Even 3 dimensions per user with cartesian = true is actually 7x times more
 * database records with something around twice as much database CPU load and a bit more Node.js CPU load.
 * Also note, though Countly will optimize database queries as much as it can, database load will increase exponentially
 * with growth of user dimensions number.
 *
 * This is EXPERIMENTAL feature, no warranty.
 */

//countlyConfig.api.users = {dimensions: true, dimensionsWhitelist: ['dimension1', 'dimension2', 'dimension3'], cartesian: false};

module.exports = countlyConfig;