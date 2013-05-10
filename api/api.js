var http = require('http'),
    path = require('path'),
    fs = require('fs'),
	url = require('url'),
	querystring = require('querystring'),
	geoip = require('geoip-lite'),
	moment = require('moment'),
	time = require('time'),
	crypto = require('crypto'),
	mongo = require('mongoskin'),
	iap = require('iap_verifier'),
	countlyConfig = require('./config'), // Config file for the app
    _api = countlyConfig.api,
    _mongo = countlyConfig.mongodb,
    _kosa = countlyConfig.iKosa,
	countlyDb = mongo.db((_mongo.user && _mongo.password ? _mongo.user + ':' + _mongo.password + '@' : '')
        + _mongo.host + ':' + _mongo.port + '/' + _mongo.db + '?auto_reconnect'),
    storedEvents = _api.events && _api.events.log ? (_api.events.whitelist || []) : undefined,
    storedDimensions = _api.users && _api.users.dimensions ? (_api.users.dimensionsWhitelist || []) : undefined;

var mimeTypes = {
    "html": "text/html",
    "txt": "text/plain",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "png": "image/png",
    "js": "text/javascript",
    "css": "text/css"};

// Global date variables
var now, timestamp, yearly, monthly, weekly, daily, hourly, appTimezone;

// Countly mongodb collections use short key names.
// This map is used to transform long key names to shorter ones.
var dbMap = {
	'events': 'e',
	'total': 't',
	'new': 'n',
	'unique': 'u',
	'duration': 'd',
	'durations': 'ds',
	'frequency': 'f',
	'loyalty': 'l',
	'sum': 's',
	'count': 'c'
};

var dbUserMap = {
	'device_id': 'did',
	'last_seen': 'ls',
	'session_duration': 'sd',
	'total_session_duration': 'tsd',
	'session_count': 'sc',
	'device': 'd',
	'carrier': 'c',
	'country_code': 'cc',
	'platform': 'p',
	'platform_version': 'pv',
	'app_version': 'av',
    "user_dimensions": 'dm'
};

var dbEventLogMap = {
	'key': 'k',
	'timestamp': 't',
	'user': 'u',
	'count': 'c',
	'sum': 's',
	'segmentation': 's',
	"user_dimensions": 'dm'
};

function isNumber(n) {
	return !isNaN(parseFloat(n)) && isFinite(n);
}

// Check objects for equality
// Probably worth switching to more complete and strict version
function isEqual(a, b, excluding){
    if (a == null || b == null) return a === b;

    var size = 0;
    for (var ap in a) {
        if (excluding && excluding.indexOf(ap) !== -1) continue;
        if (!b[ap] || a[ap] != b[ap]) return false;
        size++;
    }

    for (var bp in b){
        if (excluding && excluding.indexOf(bp) !== -1) continue;
        size--;
    }

    return size == 0;
}

// Return only dimensions of a particular level (keys number)
function filterDimensionsByLevel(arr, level){
    var ret = [];
    for (var i = 0; i < arr.length; i++){
        var keysInDimension = 0;
        for (var ak in arr[i]) if (ak != 'id') {
            keysInDimension++;
        }
        if (level == keysInDimension) ret.push(arr[i]);
    }
    return ret;
}

// Find a dimension in array of dimensions
function findDimension(arr, dimension, level, checkValue){
    var array = level ? filterDimensionsByLevel(arr, level) : arr;

    for (var i = 0; i < array.length; i++){
        var keysEqual = 0, keysInDimension = 0;

        for (var dk in dimension) if (dk != 'id') {
            keysInDimension++;

            var keysInArrayDimension = 0;
            for (var ak in array[i]) if (ak != 'id') {
                keysInArrayDimension++;

                if (ak == dk && (!checkValue || (checkValue && array[i][ak] == dimension[dk]))) {
                    keysEqual++;
                }
            }
        }

        if (keysInDimension == keysInArrayDimension && keysInDimension == keysEqual && (!level || level == keysInDimension)) return arr[i];
    }

    return null;
}

// Almost Cartesian product (also returns partial multiplications):
// cartesian([a, b, c]) = [a; b; c; a,b; a,c; b,c; a,b,c]
var cartesian = function(a){
    var combined = combine(a);
    for (var i = 0; i < combined.length; i++){
        var replacement = {};
        for (var c = 0; c < combined[i].length; c++) {
            for (var k in combined[i][c]) replacement[k] = combined[i][c][k];
        }
        combined[i] = replacement;
    }
    return combined;
}

var combine = function(a) {
    var fn = function(n, src, got, all) {
        if (n == 0) {
            if (got.length > 0) {
                all[all.length] = got;
            }
            return;
        }
        for (var j = 0; j < src.length; j++) {
            fn(n - 1, src.slice(j + 1), got.concat([src[j]]), all);
        }
    };
    var all = [];
    for (var i=0; i < a.length; i++) {
        fn(i, a, [], all);
    }
    all.push(a);
    return all;
}

// Update _id_ record of _collection_ along with all dimensions from getParams.app_user_dimensions with _update_
function updateAppIdWithDimensions(getParams, collection, id, update, options){
    var query = {_id: id};
    if (getParams.app_user_dimensions && getParams.app_user_dimensions.length) {
        query = {'$or': [{_id: id}]};
        for (var i = 0; i < getParams.app_user_dimensions.length; i++){
            query['$or'].push({_id: getParams.app_user_dimensions[i].id});
        }

        // We cannot upsert these because of $or query, we also do not like N+1.
        // Instead we switch to async checking of number of updated records and running the query again
        // if some record hasn't been processed. Far from ideal, but the only solution
        // when user have, say, 3 dimensions (7 cartesian dimensions x 5-10 updates per request = mongo chokes pretty fast).
        if (options.upsert){
            countlyDb.collection(collection).update(query, update, {multi: true, safe: true}, function(err, count){
                if (count != (getParams.app_user_dimensions.length + 1)){
                    if (count == 0) countlyDb.collection(collection).update({_id: id}, update, {upsert: true});
                    getParams.app_user_dimensions.forEach(function(d){
                        countlyDb.collection(collection).findOne(d.id, function(err, record){
                            if (!record) countlyDb.collection(collection).update({_id: d.id}, update, {upsert: true});
                        });
                    });
                }
            });
        } else {
            countlyDb.collection(collection).update(query, update, {multi: true});
        }

    } else {
        countlyDb.collection(collection).update(query, update, options);
    }
}

// Update event collections
function updateEventsWithDimensions(getParams, collection, segment, update, options){
    if (getParams.app_user_dimensions && getParams.app_user_dimensions.length) {
        countlyDb.collection(collection).update({'_id': segment}, update, options);
        for (var i = 0; i < getParams.app_user_dimensions.length; i++){
            var collectionName = collection.replace(getParams.app_id, getParams.app_user_dimensions[i].id);
            countlyDb.collection(collectionName).update({'_id': segment}, update, options);
        }
    } else {
        countlyDb.collection(collection).update({'_id': segment}, update, options);
    }
}

// Process user dimensions
// - add nonexistent dimensions to apps collection
// - find existing dimensions (key = value) ids and store in getParams for future use
// - construct cartesian product of user dimensions
// - update app_users with new dimensions if new added or existing changed
function findOrUpdateAppUserDimensions(getParams, app, user){
    if (storedDimensions === undefined) return;

    if (getParams.dimensions){
        // Convert to array of simple one-key dimensions
        var dimensions = [];
        for (var key in getParams.dimensions) {
            var dimension = {};
            dimension[key] = getParams.dimensions[key];
            dimensions.push(dimension);
        }

        // Find other one-key dimensions assigned to the user before
        var userDimensions = user ? user[dbUserMap.user_dimensions] || [] : [],
            filtered = filterDimensionsByLevel(userDimensions, 1),
            userNeedsUpdate = user ? false : true;
        for (var i = 0; i < filtered.length; i++){
            var existing = findDimension(dimensions, filtered[i], 1);
            if (!existing) {
                dimensions.push(filtered[i]);
            } else {
                var equal = false;
                for (var key in existing) if (key != 'id') {
                    // only one key in this loop
                    if (existing[key] != filtered[key]) {
                        userNeedsUpdate = true;
                    }
                }
            }
        }

        // Construct cartesian product
        if (_api.users.cartesian) dimensions = cartesian(dimensions);

        // If dimension already exists, we need to find its id
        // If not, we need to add it
        if (!app.dimensions) app.dimensions = [];
        var count = 0, newAppDimensions = [];
        for (var i = 0; i < dimensions.length; i++){
            var existing = findDimension(app.dimensions, dimensions[i], 0, true);
            if (existing){
                dimensions[i].id = existing.id;
            } else {
                dimensions[i].id = new mongo.ObjectID();
                newAppDimensions.push(dimensions[i]);
            }
        }

        // Update app if needed
        if (newAppDimensions.length) {
            countlyDb.collection('apps').update({'_id': app['_id']}, {'$pushAll': {dimensions: newAppDimensions}});
        }

        // Update user if needed
        if (userDimensions.length < dimensions.length) userNeedsUpdate = true;
        if (userNeedsUpdate) {
            countlyDb.collection('app_users' + getParams.app_id).update({'_id': getParams.app_user_id}, {'$set': {'dm': dimensions}}, {upsert: true});
        }

        // Save dimensions for future updates
        getParams.app_user_dimensions = dimensions;

    } else if (user && user[dbUserMap.user_dimensions]) {
        // Save dimensions for future updates
        getParams.app_user_dimensions = user[dbUserMap.user_dimensions];
    }
}

// Initialization of the global time variables yearly, monthly, daily etc.
// Also adjusts the time to current app's configured timezone.
function initTimeVars(appTimezone, reqTimestamp) {
	var tmpTimestamp;
	
	// Check if the timestamp paramter exists in the request and is an 10 digit integer
	if (reqTimestamp && (reqTimestamp + "").length == 10 && isNumber(reqTimestamp)) {
		// If the received timestamp is greater than current time use the current time as timestamp
		tmpTimestamp = (reqTimestamp > time.time())? time.time() : reqTimestamp;
	}

	// Set the timestamp to request parameter value or the current time
	timestamp = (tmpTimestamp)? tmpTimestamp : time.time();

	// Construct the a date object from the received timestamp or current time
	now = (tmpTimestamp)? new time.Date(tmpTimestamp * 1000) : new time.Date();
	now.setTimezone(appTimezone);
	
	yearly = now.getFullYear();
	monthly = yearly + '.' + (now.getMonth() + 1);
	daily = monthly + '.' + (now.getDate());
	hourly = daily + '.' + (now.getHours());
	weekly = Math.ceil(moment(now.getTime()).format("DDD") / 7);
}

// Checks app_key from the http request against "apps" collection. 
// This is the first step of every write request to API.
function validateAppForWriteAPI(getParams) {
	countlyDb.collection('apps').findOne({'key': getParams.app_key}, function(err, app){
		if (!app) {
			return false;
		}
		
		getParams.app_id = app['_id'];
		getParams.app_cc = app['country'];
		appTimezone = app['timezone']; // Global var appTimezone
		
		initTimeVars(appTimezone, getParams.timestamp);

        countlyDb.collection('app_users' + getParams.app_id).findOne({'_id': getParams.app_user_id }, function(err, dbAppUser){

            findOrUpdateAppUserDimensions(getParams, app, dbAppUser);

            if (getParams.events) {
                var updateSessions = {};
                fillTimeObject(updateSessions, dbMap['events']);
                updateAppIdWithDimensions(getParams, 'sessions', getParams.app_id, {'$inc': updateSessions}, {upsert: true});

                processEvents(getParams);
            } else if (getParams.session_duration) {
                processSessionDuration(getParams);
            } else {
                checkUserLocation(getParams, dbAppUser);
            }

        });

	});
}

function validateAppForReadAPI(getParams, callback, collection, res) {
	countlyDb.collection('apps').findOne({'key': getParams.app_key}, function(err, app){
		if (!app) {
			res.end();
			return false;
		}
		
		getParams.app_id = app['_id'];
		getParams.dimension_id = app['_id'];
		appTimezone = app['timezone']; // Global var appTimezone

        // Change app_id to dimension id if it's correct dimension
        if (getParams.dimensions && app.dimensions) {
            var dim = getParams.dimensions.split('|');
            if (dim.length == 1) {
                app.dimensions.forEach(function(d){
                    try {
                        if (("" + d.id) == dim[0]) getParams.dimension_id = new mongo.ObjectID(dim[0]);
                    } catch (Error){ // ignore
                    }
                });
            }
        }
		
		initTimeVars(appTimezone, getParams.timestamp);
		callback(getParams, collection, res);
	});
}

// Creates a time object in the format object["2012.7.20.property"] = increment.
function fillTimeObject(object, property, increment) {
	var increment = (increment)? increment : 1;
	
	object[yearly + '.' + property] = increment;
	object[monthly + '.' + property] = increment;
	object[daily + '.' + property] = increment;
	
	// If the property parameter contains a dot, hourly data is not saved in 
	// order to prevent two level data (such as 2012.7.20.TR.u) to get out of control. 
	if (property.indexOf('.') == -1) {
		object[hourly + '.' + property] = increment;
	}
	
	// For properties that hold the unique visitor count we store weekly data as well.
	if (property.substr(-2) == ("." + dbMap["unique"]) || 
		property == dbMap["unique"] ||
		property.substr(0,2) == (dbMap["frequency"] + ".") ||
		property.substr(0,2) == (dbMap["loyalty"] + "."))
	{
		object[yearly + ".w" + weekly + '.' + property] = increment;
	}
}

// Performs geoip lookup for the IP address of the app user
function checkUserLocation(getParams, dbAppUser) {
	// Location of the user is retrieved using geoip-lite module from her IP address.
	var locationData = geoip.lookup(getParams.ip_address);

	if (locationData) {
		if (locationData.country) {
			getParams.user.country = locationData.country;
		}
		
		if (locationData.city) {
			getParams.user.city = locationData.city;
		} else {
			getParams.user.city = 'Unknown';
		}
		
		// Coordinate values of the user location has no use for now
		if (locationData.ll) {
			getParams.user.lat = locationData.ll[0];
			getParams.user.lng = locationData.ll[1];
		}
	}
	
	processUserLocation(getParams, dbAppUser);
}

function processUserLocation(getParams, dbAppUser) {
	// If begin_session exists in the API request
	if (getParams.is_begin_session) {
		// Before processing the session of the user we check if she exists in app_users collection.
        processUserSession(dbAppUser, getParams);
	} else if (getParams.is_end_session) { // If end_session exists in the API request
		if (getParams.session_duration) {
			processSessionDuration(getParams);
		}

        // If the user does not exist in the app_users collection or it does not have any
        // previous session duration stored than we don't need to calculate the session
        // duration range for this user.
        if (dbAppUser && dbAppUser[dbUserMap['session_duration']]) {
            processSessionDurationRange(getParams, dbAppUser[dbUserMap['session_duration']]);
        }
	} else {
	
		// If the API request is not for begin_session or end_session it has to be for 
		// session duration calculation.
		if (getParams.session_duration) {
			processSessionDuration(getParams);
		}
	}
}

function getUserMetrics(getParams) {
	var tmp_metrics = {},
		allowed_user_metrics = ['_os', '_os_version', '_device', '_resolution', '_carrier', '_app_version'];
	
	for (var metric in getParams.metrics) {
		if (allowed_user_metrics.indexOf(metric) !== -1) {
			tmp_metrics[metric] = getParams.metrics[metric];
		}
	}
	
	return tmp_metrics;
}

function processSessionDurationRange(getParams, totalSessionDuration) {
	var durationRanges = [
			[0,10],
			[11,30],
			[31,60],
			[61,180],
			[181,600],
			[601,1800],
			[1801,3600]
		],
		durationMax = 3601,
		calculatedDurationRange,
		updateSessions = {};
		
		if (totalSessionDuration >= durationMax) {
			calculatedDurationRange = (durationRanges.length) + '';
		} else {
			for (var i=0; i < durationRanges.length; i++) {
				if (totalSessionDuration <= durationRanges[i][1] && totalSessionDuration >= durationRanges[i][0]) {
					calculatedDurationRange = i + '';
					break;
				}
			}
		}
		
		fillTimeObject(updateSessions, dbMap['durations'] + '.' + calculatedDurationRange);
        updateAppIdWithDimensions(getParams, 'sessions', getParams.app_id, {'$inc': updateSessions, '$addToSet': {'meta.d-ranges': calculatedDurationRange}}, {upsert: false});

		// sd: session duration. dbUserMap is not used here for readability purposes.
		countlyDb.collection('app_users' + getParams.app_id).update({'_id': getParams.app_user_id}, {'$set': {'sd': 0}}, {'upsert': true});
}

function processSessionDuration(getParams) {
	var updateSessions = {},
		session_duration = parseInt(getParams.session_duration);
	
	if (session_duration == (session_duration | 0)) {
		fillTimeObject(updateSessions, dbMap['duration'], session_duration);

        updateAppIdWithDimensions(getParams, 'sessions', getParams.app_id, {'$inc': updateSessions}, {upsert: true});

		// sd: session duration, tsd: total session duration. dbUserMap is not used here for readability purposes.
		countlyDb.collection('app_users' + getParams.app_id).update({'_id': getParams.app_user_id}, {'$inc': {'sd': session_duration, 'tsd': session_duration}}, {'upsert': true});
	}
}

function processUserSession(dbAppUser, getParams) {
	var updateSessions = {},
		updateUsers = {},
		updateLocations = {},
		updateCities = {},
		userRanges = {},
		loyaltyRanges = [
			[0,1],
			[2,2],
			[3,5],
			[6,9],
			[10,19],
			[20,49],
			[50,99],
			[100,499]
		],
		sessionFrequency = [
			[0,1],
			[1,24],
			[24,48],
			[48,72],
			[72,96],
			[96,120],
			[120,144],
			[144,168],
			[168,192],
			[192,360],
			[360,744]
		],
		sessionFrequencyMax = 744,
		calculatedFrequency,
		loyaltyMax = 500,
		calculatedLoyaltyRange,
		uniqueLevels = [],
		isNewUser = false;
	
	fillTimeObject(updateSessions, dbMap['total']);
	fillTimeObject(updateLocations, getParams.user.country + '.' + dbMap['total']);
	fillTimeObject(updateCities, getParams.user.city + '.' + dbMap['total']);
	
	if (dbAppUser) {
		if ((timestamp - dbAppUser[dbUserMap['last_seen']]) >= (sessionFrequencyMax * 60 * 60)) {
			calculatedFrequency = sessionFrequency.length + '';
		} else {
			for (var i=0; i < sessionFrequency.length; i++) {
				if ((timestamp - dbAppUser[dbUserMap['last_seen']]) < (sessionFrequency[i][1] * 60 * 60) && 
					(timestamp - dbAppUser[dbUserMap['last_seen']]) >= (sessionFrequency[i][0] * 60 * 60)) {
					calculatedFrequency = i + '';
					break;
				}
			}
		}
		
		var userSessionCount = dbAppUser[dbUserMap['session_count']] + 1;

		//Calculate the loyalty range of the user
		if (userSessionCount >= loyaltyMax) {
			calculatedLoyaltyRange = loyaltyRanges.length + '';
		} else {
			for (var i=0; i < loyaltyRanges.length; i++) {
				if (userSessionCount <= loyaltyRanges[i][1] && userSessionCount >= loyaltyRanges[i][0]) {
					calculatedLoyaltyRange = i + '';
					break;
				}
			}
		}
		
		var secInMin = (60 * (now.getMinutes())) + now.getSeconds(),
			secInHour = (60 * 60 * (now.getHours())) + secInMin,
			secInMonth = (60 * 60 * 24 * (now.getDate() - 1)) + secInHour;
			
		var currentTime = new time.Date(dbAppUser[dbUserMap['last_seen']] * 1000);
		currentTime.setTimezone(appTimezone);
		
		var userLastSessionWeek = Math.ceil(moment(currentTime.getTime()).format("DDD") / 7),
			userLastSessionYear = moment(currentTime.getTime()).format("YYYY");
		
		if (userLastSessionYear == yearly && userLastSessionWeek < weekly) {
			uniqueLevels[uniqueLevels.length] = yearly + ".w" + weekly;
		}
		if (dbAppUser[dbUserMap['last_seen']] <= (timestamp - secInMin)) {
			// We don't need to put hourly fragment to the unique levels array since
			// we will store hourly data only in sessions collection
			updateSessions[hourly + '.' + dbMap['unique']] = 1;
		}
		if (dbAppUser[dbUserMap['last_seen']] <= (timestamp - secInHour)) {
			uniqueLevels[uniqueLevels.length] = daily;
		}
		if (dbAppUser[dbUserMap['last_seen']] <= (timestamp - secInMonth)) {
			uniqueLevels[uniqueLevels.length] = monthly;
		}
		if (dbAppUser[dbUserMap['last_seen']] < (timestamp - secInMonth)) {
			uniqueLevels[uniqueLevels.length] = yearly;
		}

		for (var i=0; i < uniqueLevels.length; i++) {
			updateSessions[uniqueLevels[i] + '.' + dbMap['unique']] = 1;
			updateLocations[uniqueLevels[i] + '.' + getParams.user.country + '.' + dbMap['unique']] = 1;
			updateCities[uniqueLevels[i] + '.' + getParams.user.city + '.' + dbMap['unique']] = 1;
			updateUsers[uniqueLevels[i] + '.' + dbMap['frequency'] + '.' + calculatedFrequency] = 1;
			updateUsers[uniqueLevels[i] + '.' + dbMap['loyalty'] + '.' + calculatedLoyaltyRange] = 1;
		}
		
		if (uniqueLevels.length != 0) {
			userRanges['meta.' + 'f-ranges'] = calculatedFrequency;
			userRanges['meta.' + 'l-ranges'] = calculatedLoyaltyRange;
            updateAppIdWithDimensions(getParams, 'users', getParams.app_id, {'$inc': updateUsers, '$addToSet': userRanges}, {'upsert': true});
		}
		
	} else {
		isNewUser = true;
		
		// User is not found in app_users collection so this means she is both a new and unique user.
		fillTimeObject(updateSessions, dbMap['new']);
		fillTimeObject(updateSessions, dbMap['unique']);
		fillTimeObject(updateLocations, getParams.user.country + '.' + dbMap['new']);
		fillTimeObject(updateLocations, getParams.user.country + '.' + dbMap['unique']);
		fillTimeObject(updateCities, getParams.user.city + '.' + dbMap['new']);
		fillTimeObject(updateCities, getParams.user.city + '.' + dbMap['unique']);
		
		// First time user.
		calculatedLoyaltyRange = '0';
		calculatedFrequency = '0';
		
		fillTimeObject(updateUsers, dbMap['frequency'] + '.' + calculatedFrequency);
		userRanges['meta.' + 'f-ranges'] = calculatedFrequency;
		
		fillTimeObject(updateUsers, dbMap['loyalty'] + '.' + calculatedLoyaltyRange);
		userRanges['meta.' + 'l-ranges'] = calculatedLoyaltyRange;

        updateAppIdWithDimensions(getParams, 'users', getParams.app_id, {'$inc': updateUsers, '$addToSet': userRanges}, {'upsert': true});
	}

    updateAppIdWithDimensions(getParams, 'sessions', getParams.app_id, {'$inc': updateSessions}, {'upsert': true});
    updateAppIdWithDimensions(getParams, 'locations', getParams.app_id, {'$inc': updateLocations, '$addToSet': {'meta.countries': getParams.user.country}}, {'upsert': true});

	if (getParams.app_cc == getParams.user.country) {
        updateAppIdWithDimensions(getParams, 'cities', getParams.app_id, {'$inc': updateCities, '$set': {'country': getParams.user.country}, '$addToSet': {'meta.cities': getParams.user.city}}, {'upsert': true});
	}
	
	processPredefinedMetrics(getParams, isNewUser, uniqueLevels);
}

function processPredefinedMetrics(getParams, isNewUser, uniqueLevels) {

	var userProps = {};
	
	userProps[dbUserMap['last_seen']] = timestamp;
	userProps[dbUserMap['device_id']] = getParams.device_id;
	userProps[dbUserMap['country_code']] = getParams.user.country;

	if (!getParams.metrics) {
		// sc: session count. dbUserMap is not used here for readability purposes.
		countlyDb.collection('app_users' + getParams.app_id).update({'_id': getParams.app_user_id}, {'$inc': {'sc': 1}, '$set': userProps}, {'upsert': true});
		return false;
	}
	
	var predefinedMetrics = [
		{ db: "devices", metrics: [{ name: "_device", set: "devices", short_code: dbUserMap['device'] }] },
		{ db: "carriers", metrics: [{ name: "_carrier", set: "carriers", short_code: dbUserMap['carrier'] }] },
		{ db: "device_details", metrics: [{ name: "_os", set: "os", short_code: dbUserMap['platform'] }, { name: "_os_version", set: "os_versions", short_code: dbUserMap['platform_version'] }, { name: "_resolution", set: "resolutions" }] },
		{ db: "app_versions", metrics: [{ name: "_app_version", set: "app_versions", short_code: dbUserMap['app_version'] }] }
	];
	
	for (var i=0; i < predefinedMetrics.length; i++) {
		var tmpTimeObj = {},
			tmpSet = {},
			needsUpdate = false;
	
		for (var j=0; j < predefinedMetrics[i].metrics.length; j++) {
			var tmpMetric = predefinedMetrics[i].metrics[j],
				recvMetricValue = getParams.metrics[tmpMetric.name];
				
			if (recvMetricValue) {
				var escapedMetricVal = recvMetricValue.replace(/^\$/, "").replace(/\./g, ":");
				needsUpdate = true;
				tmpSet["meta." + tmpMetric.set] = escapedMetricVal;
				fillTimeObject(tmpTimeObj, escapedMetricVal + '.' + dbMap['total']);
				
				if (isNewUser) {
					fillTimeObject(tmpTimeObj, escapedMetricVal + '.' + dbMap['new']);
					fillTimeObject(tmpTimeObj, escapedMetricVal + '.' + dbMap['unique']);
				} else {
					for (var k=0; k < uniqueLevels.length; k++) {
						tmpTimeObj[uniqueLevels[k] + '.' + escapedMetricVal + '.' + dbMap['unique']] = 1;
					}
				}
				
				// Assign properties to app_users document of the current user
				if (tmpMetric.short_code) {
					userProps[tmpMetric.short_code] = escapedMetricVal;
				}
			}
		}
		
		if (needsUpdate) {
            updateAppIdWithDimensions(getParams, predefinedMetrics[i].db, getParams.app_id, {'$inc': tmpTimeObj, '$addToSet': tmpSet}, {'upsert': true});
		}
	}
	
	// sc: session count. dbUserMap is not used here for readability purposes.
	countlyDb.collection('app_users' + getParams.app_id).update({'_id': getParams.app_user_id}, {'$inc': {'sc': 1}, '$set': userProps}, {'upsert': true});
}

function mergeEvents(obj1, obj2) {
	for (var level1 in obj2) {
		if (!obj1[level1]) {
			obj1[level1] = obj2[level1];
			continue;
		}

		for (var level2 in obj2[level1]) {
			if (obj1[level1][level2]) {
				obj1[level1][level2] += obj2[level1][level2];
			} else {
				obj1[level1][level2] = obj2[level1][level2];
			}
		}
	}
}

// Adds item to array arr if it is not already present
function arrayAddUniq(arr, item) {
	if (arr.indexOf(item) == -1) {
		arr[arr.length] = item;
	}
};

// Process events received in the following format;
/*
	[
		{
			"key": "event_key", 
			"count": 1, 
			"sum": 0.99, 
			"segmentation": {
				"seg_key1": seg_val1, 
				"seg_key2": seg_val2
			}
		}
	]
*/
function processEvents(getParams) {
	if (!getParams.events) {
		return false;
	}
	
	var events = [],
		eventCollections = {},
		eventSegments = {},
		tmpEventObj = {},
		shortCollectionName = "",
		eventCollectionName = "",
		eventLogs = [];
	
	for (var i=0; i < getParams.events.length; i++) {
		
		var currEvent = getParams.events[i];
		tmpEventObj = {};
		tmpEventColl = {};
	
		// Key and count fields are required
		if (!currEvent.key || !currEvent.count || !isNumber(currEvent.count)) {
			continue;
		}
		
		// Mongodb collection names can not contain system. or $
		shortCollectionName = currEvent.key.replace(/system\.|\$/g, "");
		eventCollectionName = shortCollectionName + getParams.app_id;

		// Mongodb collection names can not be longer than 128 characters
		if (eventCollectionName.length > 128) {
			continue;
		}
		
		// If present use timestamp inside each event while recording
		if (getParams.events[i].timestamp) {
			initTimeVars(appTimezone, getParams.events[i].timestamp);
		}

        if (storedEvents !== undefined && (storedEvents.length == 0 || storedEvents.indexOf(currEvent.key) !== -1)){
            var loggedEvent = {
                _id: currEvent.id || undefined
            };

            loggedEvent[dbEventLogMap.key] = currEvent.key;
            loggedEvent[dbEventLogMap.timestamp] = Math.round(now.getTime() / 1000);
            loggedEvent[dbEventLogMap.user] = getParams.app_user_id;
            loggedEvent[dbEventLogMap.count] = currEvent.count;
            loggedEvent[dbEventLogMap.sum] = currEvent.sum;
            loggedEvent[dbEventLogMap.segmentation] = currEvent.segmentation;

            // TODO: think about loggedEvent[dbEventLogMap.user_dimensions]
            if (getParams.app_user_dimensions) loggedEvent[dbEventLogMap.user_dimensions] = getParams.app_user_dimensions;

            eventLogs.push(loggedEvent);
        }

        arrayAddUniq(events, shortCollectionName);
		
		if (currEvent.sum && isNumber(currEvent.sum)) {
			fillTimeObject(tmpEventObj, dbMap['sum'], currEvent.sum);
		}
		fillTimeObject(tmpEventObj, dbMap['count'], currEvent.count);
		
		tmpEventColl["no-segment"] = tmpEventObj;
		
		if (currEvent.segmentation) {
			for (var segKey in currEvent.segmentation) {
			
				if (!currEvent.segmentation[segKey]) {
					continue;
				}
			
				tmpEventObj = {};
				var tmpSegVal = currEvent.segmentation[segKey] + "";
				
				// Mongodb field names can't start with $ or contain .
				tmpSegVal = tmpSegVal.replace(/^\$/, "").replace(/\./g, ":");

				if (currEvent.sum && isNumber(currEvent.sum)) {
					fillTimeObject(tmpEventObj, tmpSegVal + '.' + dbMap['sum'], currEvent.sum);
				}
				fillTimeObject(tmpEventObj, tmpSegVal + '.' + dbMap['count'], currEvent.count);
				
				if (!eventSegments[eventCollectionName]) {
					eventSegments[eventCollectionName] = {};
				}
				
				if (!eventSegments[eventCollectionName]['meta.' + segKey]) {
					eventSegments[eventCollectionName]['meta.' + segKey] = {};
				}
				
				if (eventSegments[eventCollectionName]['meta.' + segKey]["$each"] && eventSegments[eventCollectionName]['meta.' + segKey]["$each"].length) {
					arrayAddUniq(eventSegments[eventCollectionName]['meta.' + segKey]["$each"], tmpSegVal);
				} else {
					eventSegments[eventCollectionName]['meta.' + segKey]["$each"] = [tmpSegVal];
				}
				
				if (!eventSegments[eventCollectionName]["meta.segments"]) {
					eventSegments[eventCollectionName]["meta.segments"] = {};
					eventSegments[eventCollectionName]["meta.segments"]["$each"] = [];
				}
				
				arrayAddUniq(eventSegments[eventCollectionName]["meta.segments"]["$each"], segKey);
				tmpEventColl[segKey] = tmpEventObj;
			}
		} else if (currEvent.seg_val && currEvent.seg_key) {
			tmpEventObj = {};
			
			// Mongodb field names can't start with $ or contain .
			currEvent.seg_val = currEvent.seg_val.replace(/^\$/, "").replace(/\./g, ":");

			if (currEvent.sum && isNumber(currEvent.sum)) {
				fillTimeObject(tmpEventObj, currEvent.seg_val + '.' + dbMap['sum'], currEvent.sum);
			}
			fillTimeObject(tmpEventObj, currEvent.seg_val + '.' + dbMap['count'], currEvent.count);
			
			if (!eventSegments[eventCollectionName]) {
				eventSegments[eventCollectionName] = {};
			}
			
			if (!eventSegments[eventCollectionName]['meta.' + currEvent.seg_key]) {
				eventSegments[eventCollectionName]['meta.' + currEvent.seg_key] = {};
			}
			
			if (eventSegments[eventCollectionName]['meta.' + currEvent.seg_key]["$each"] && eventSegments[eventCollectionName]['meta.' + currEvent.seg_key]["$each"].length) {
				arrayAddUniq(eventSegments[eventCollectionName]['meta.' + currEvent.seg_key]["$each"], currEvent.seg_val);
			} else {
				eventSegments[eventCollectionName]['meta.' + currEvent.seg_key]["$each"] = [currEvent.seg_val];
			}
			
			if (!eventSegments[eventCollectionName]["meta.segments"]) {
				eventSegments[eventCollectionName]["meta.segments"] = {};
				eventSegments[eventCollectionName]["meta.segments"]["$each"] = [];
			}
			
			arrayAddUniq(eventSegments[eventCollectionName]["meta.segments"]["$each"], currEvent.seg_key);
			tmpEventColl[currEvent.seg_key] = tmpEventObj;
		}
		
		if (!eventCollections[eventCollectionName]) {
			eventCollections[eventCollectionName] = {};
		}
		
		mergeEvents(eventCollections[eventCollectionName], tmpEventColl);
	}
	
	for (var collection in eventCollections) {
		for (var segment in eventCollections[collection]) {
			if (segment == "no-segment") {
				if (eventSegments[collection]) {
                    updateEventsWithDimensions(getParams, collection, segment, {'$inc': eventCollections[collection][segment], '$addToSet': eventSegments[collection]}, {'upsert': true});
				} else {
                    updateEventsWithDimensions(getParams, collection, segment, {'$inc': eventCollections[collection][segment]}, {'upsert': true});
				}
			} else {
                updateEventsWithDimensions(getParams, collection, segment, {'$inc': eventCollections[collection][segment]}, {'upsert': true});
			}
		}
	}

    if (eventLogs.length) countlyDb.collection('event__log' + getParams.app_id).insert(eventLogs, {keepGoing: true});

	if (events.length) {
		var eventSegmentList = {'$addToSet': {'list': {'$each': events}}};
		
		for (var event in eventSegments) {
			if (!eventSegmentList['$addToSet']["segments." + event.replace(getParams.app_id, "")]) {
				eventSegmentList['$addToSet']["segments." + event.replace(getParams.app_id, "")] = {};
			}
		
			if (eventSegments[event]['meta.segments']) {
				eventSegmentList['$addToSet']["segments." + event.replace(getParams.app_id, "")] = eventSegments[event]['meta.segments'];
			}
		}

		countlyDb.collection('events').update({'_id': getParams.app_id}, eventSegmentList, {'upsert': true});
	}
}

var preFetchEventData = function(getParams, collection, res) {
	if (!getParams.event) {
		countlyDb.collection('events').findOne({'_id' : getParams.dimension_id}, function(err, result){
			if (result && result.list) {
				collection = result.list[0];
				fetchEventData(getParams, collection + getParams.dimension_id, res);
			} else {			
				if (getParams.callback) {
					result = getParams.callback + "({})";
				} else {
					result = {};
				}
			
				res.writeHead(200, {'Content-Type': 'application/json'});
				res.write(result);
				res.end();
			}
		});
	} else {
		fetchEventData(getParams, getParams.event + getParams.dimension_id, res);
	}
}

var fetchEventData = function(getParams, collection, res) {
	var fetchFields = {};

	if (getParams.action == "refresh") {
		fetchFields[daily] = 1;
		fetchFields['meta'] = 1;
	}

	countlyDb.collection(collection).find({}, fetchFields).toArray(function(err, result){
		if (!result.length) {
			now = new time.Date();
			result = {};
			result[now.getFullYear()] = {};
		}
		
		if (getParams.callback) {
			result = getParams.callback + "(" + JSON.stringify(result) + ")";
		} else {
			result = JSON.stringify(result);
		}
				
		res.writeHead(200, {'Content-Type': 'application/json'});
		res.write(result);
		res.end();
	});
}

var fetchCollection = function(getParams, collection, res) {
	countlyDb.collection(collection).findOne({'_id' : getParams.app_id}, function(err, result){
		if (!result) {
			result = {};
		}

        // Need to override ID to handle dimension changes on client
        result._id = getParams.dimension_id;
		
		if (getParams.callback) {
			result = getParams.callback + "(" + JSON.stringify(result) + ")";
		} else {
			result = JSON.stringify(result);
		}
				
		res.writeHead(200, {'Content-Type': 'application/json'});
		res.write(result);
		res.end();
	});
}

var fetchTimeData = function(getParams, collection, res) {

	var fetchFields = {};

	if (getParams.action == "refresh") {
		fetchFields[daily] = 1;
		fetchFields['meta'] = 1;
	}

	countlyDb.collection(collection).findOne({'_id' : getParams.dimension_id}, fetchFields, function(err, result){
		if (!result) {
			now = new time.Date();
			result = {};
			result[now.getFullYear()] = {};
		}
		
		if (getParams.callback) {
			result = getParams.callback + "(" + JSON.stringify(result) + ")";
		} else {
			result = JSON.stringify(result);
		}
				
		res.writeHead(200, {'Content-Type': 'application/json'});
		res.write(result);
		res.end();
	});
}

var walk = function(dir, done) {
    var results = [];
    fs.readdir(dir, function(err, list) {
        if (err) return done(err);
        var pending = list.length;
        if (!pending) return done(null, results);
        list.forEach(function(file) {
            file = dir + '/' + file;
            fs.stat(file, function(err, stat) {
                if (stat && stat.isDirectory()) {
                    walk(file, function(err, res) {
                        results = results.concat(res);
                        if (!--pending) done(null, results);
                    });
                } else {
                    results.push(file);
                    if (!--pending) done(null, results);
                }
            });
        });
    });
};

var findStep = function(lesson, num) {
    for (var i = 0; i < lesson.steps.length; i++) {
        if (lesson.steps[i].num == num) return lesson.steps[i];
    }

    lesson.steps.push({num: num});
    return lesson.steps[lesson.steps.length - 1];
}

var resourcePath = function(lesson, file) {
    return _kosa.server + '/d?resource=' + encodeURIComponent(lesson + '/' + file);
}

var iapId = function(num) {
    return _kosa.iap + num;
}

var encodeIapNumber = function(num, user) {
    return encodeIap(iapId(num) + '|' + user);
}

var encodeIap = function(text) {
    var cipher = crypto.createCipher('aes-256-cbc', _kosa.secret);
    var crypted = cipher.update(text,'utf8','hex');
    crypted += cipher.final('hex')
    return crypted;
}

var decodeIapNumber = function(text) {
    var decoded = decodeIap(text);
    return decoded && decoded.indexOf(_kosa.iap) === 0 ? decoded.substr(_kosa.iap.length, 2) : '';
}

var decodeIap = function(text) {
    var decipher = crypto.createDecipher('aes-256-cbc', _kosa.secret)
    var dec = decipher.update(text,'hex','utf8')
    dec += decipher.final('utf8')
    return dec;
}

var readPost = function(req, callback) {
    var fullBody = '';
    req.on('data', function(chunk) {
        fullBody += chunk.toString();
    });

    req.on('end', function() {
        var urlParts = url.parse(req.url, true).query;
        var postParams = querystring.parse(fullBody);
        for (var p in postParams) urlParts[p] = postParams[p];
        callback(urlParts);
    });
}

var encodeLessons = function(lessons, user) {
    var results = [];
    lessons.forEach(function(num){
        results.push(encodeIapNumber(num, user));
    });
    return results.join(';');
}

var decodeLessons = function(req, callback) {
    var urlParts = url.parse(req.url, true).query;
    if (req.method == 'GET'){
        callback(_decodeLessons(urlParts.lessons), urlParts);
    } else {
        readPost(req, function(params){
            callback(_decodeLessons(params.lessons), params);
        });
    }
}

var _decodeLessons = function(text) {
    var parts = text ? text.split(';') : [];
    var results = [];
    parts.forEach(function(text){
        results.push(decodeIapNumber(text));
    });
    return results;
}

var parseResources = function(getParams, res) {
    var waiting = 0;
    var add  = function(i, m) {
        waiting += i;
        console.log("adding " + i + " (total " + waiting + ") because / " + m);
    };
    var done = function(m) {
        if (!--waiting) {
            var responseJson = {
                lessons: lessons,
                purchases: encodeLessons(getParams.lessons, getParams.auth)
            };
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.write(JSON.stringify(responseJson));
            res.end();
        }
        console.log("done 1 (total " + waiting + ") because / " + m);
    };
    var lessons = [];
    [_kosa.freeResources, _kosa.paidResources].forEach(function(dir){
        fs.readdir(dir, function(err, less){
            if (err) throw err;

            add(less.length, "lessons dir " + dir);
            less.forEach(function(les){
                fs.stat(dir + '/' + les, function(err, stat){
                    if (stat && stat.isDirectory()) {
                        var lesson = {
                            id: _kosa.iap + les.split('.')[0],
                            num: les.split('.')[0],
                            title: les.split('.')[1],
                            steps: [],
                            paid: dir == _kosa.paidResources
                        };
                        lessons.push(lesson);

                        add(1, "lesson " + les + " dir");
                        fs.readdir(dir + '/' + les, function(err, files){
                            if (err) throw err;

                            add(files.length, "lesson " + les + " files ");
                            files.forEach(function(file){
                                var parts = file.split('.'),
                                    ext = parts[parts.length - 1],
                                    num = parts[0];

                                // don't allow to get contents for unpaid lesson
                                if (lesson.paid &&
                                        num != 'preview' &&
                                        num != 'result' &&
                                        num != 'bigresult' &&
                                        getParams.lessons.indexOf(lesson.num) == -1 &&
                                        getParams.lessons.indexOf('XX') == -1 &&
                                        getParams.lessons.indexOf('YY') == -1 &&
                                        getParams.lessons.indexOf('ZZ') == -1) {
                                    done('not allowed ' + file);
                                    return;
                                }

                                if (ext == 'htm') {
                                    findStep(lesson, num).title = parts[1];
                                    fs.readFile(dir + '/' + les + '/' + file, 'utf8', function (err, data) {
                                        if (err) throw err;
                                        findStep(lesson, num).desc = data;
                                        done("file " + file + " read");
                                    });
                                } else if (ext == 'html') {
                                    findStep(lesson, num).title = parts[1];
                                    fs.readFile(dir + '/' + les + '/' + file, 'utf8', function (err, data) {
                                        if (err) throw err;
                                        findStep(lesson, num).text = data;
                                        done("file " + file + " read");
                                    });
                                } else if (ext == 'jpg' || ext == 'png') {
                                    if (num == 'preview') lesson.icon = resourcePath(les, file);
                                    else if (num == 'result') lesson.titleIcon = resourcePath(les, file);
                                    else if (num == 'bigresult') lesson.titlePhoto = resourcePath(les, file);
                                    else if (parts.length > 2) findStep(lesson, num).icon = resourcePath(les, file);
                                    else findStep(lesson, num).photo = resourcePath(les, file);
                                    done("image processed");
                                } else {
                                    done("invalid file " + file);
                                }
                            });
                            done("lesson directory done");
                        });
                    }
                    done("lesson done: ");
                });
            })
        });
    });
}

http.Server(function(req, res) {
	var urlParts = url.parse(req.url, true);
	
	switch(urlParts.pathname) {
	
		case '/i':
			var	queryString = urlParts.query;
			var getParams = {
					'app_id': '',
					'app_cc': '',
					'app_key': queryString.app_key,
					'ip_address': req.headers['x-forwarded-for'] || req.connection.remoteAddress,
					'sdk_version': queryString.sdk_version,
					'device_id': queryString.device_id,
					'metrics': queryString.metrics,
					'events': queryString.events,
					'dimensions': queryString.dimensions,
					'session_duration': queryString.session_duration,
					'session_duration_total': queryString.session_duration_total,
					'is_begin_session': queryString.begin_session,
					'is_end_session': queryString.end_session,
					'user' : {
						'country': 'Unknown',
						'city': 'Unknown'
					},
					'timestamp': queryString.timestamp
				};
			
			if (!getParams.app_key || !getParams.device_id) {
				res.writeHead(400);
				res.end();
				return false;
			} else {
				// Set app_user_id that is unique for each user of an application.
                if (_api.dropDeviceIdBackwardsCompatibility) getParams.app_user_id = getParams.device_id;
                else getParams.app_user_id = crypto.createHash('sha1').update(getParams.app_key + getParams.device_id + "").digest('hex');
			}
			
			if (getParams.metrics) {
				try {
					getParams.metrics = JSON.parse(getParams.metrics);

					if (getParams.metrics["_carrier"]) {
						getParams.metrics["_carrier"] = getParams.metrics["_carrier"].replace(/\w\S*/g, function(txt){return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();});
					}
					
					if (getParams.metrics["_os"] && getParams.metrics["_os_version"]) {
						getParams.metrics["_os_version"] = getParams.metrics["_os"][0].toLowerCase() + getParams.metrics["_os_version"];
					}
					
				} catch (SyntaxError) {
                    delete getParams.metrics;
                    console.log('Metrics JSON parsing failed');
                }
			}
			
			if (getParams.events) {
				try {
					getParams.events = JSON.parse(getParams.events);
				} catch (SyntaxError) {
                    delete getParams.events;
                    console.log('Events JSON parsing failed');
                }
			}

			if (storedDimensions !== undefined && getParams.dimensions) {
				try {
                    var parsed = JSON.parse(getParams.dimensions);
                    getParams.dimensions = {};
                    for (var p in parsed){
                        if (storedDimensions.length == 0 || storedDimensions.indexOf(p) !== -1) {
                            // Mongodb field names can't start with $ or contain .
                            var key = (p + "").replace(/^\$/, "").replace(/\./g, ":");
                            getParams.dimensions[key] = parsed[p] + "";
                        }
                    }
				} catch (SyntaxError) {
                    delete getParams.dimensions;
                    console.log('User dimensions JSON parsing failed');
                }
            }

			validateAppForWriteAPI(getParams);
			
			res.writeHead(200);
			res.end();
	
			break;
		case '/o':
			var	queryString = urlParts.query;
			var getParams = {
					'app_key': queryString.app_key,
					'method': queryString.method,
					'event': queryString.event,
					'callback': queryString.callback,
					'action': queryString.action,
                    'dimensions': queryString.dimensions
				};
				
			if (!getParams.app_key) {
				res.writeHead(400);
				res.end();
				return false;
			}

			switch (getParams.method) {
				case 'locations':
				case 'sessions':
				case 'users':
				case 'devices':
				case 'device_details':
				case 'carriers':
				case 'app_versions':
				case 'cities':
					validateAppForReadAPI(getParams, fetchTimeData, getParams.method, res);
					break;
				case 'events':
					validateAppForReadAPI(getParams, preFetchEventData, getParams.method, res);
					break;
				case 'get_events':
					validateAppForReadAPI(getParams, fetchCollection, 'events', res);
					break;
				default:
					res.writeHead(400);
					res.end();
					break;
			}

			break;
        case '/p':
            decodeLessons(req, function(lessons, params){
                if (!params.receipt) {
                    res.writeHead(471);
                    res.end();
                    return false;
                }

                if (!params.auth) {
                    res.writeHead(403);
                    res.end();
                    return false;
                }

                var verifier = new iap();
                verifier.verifyReceipt(params.receipt, function(valid, msg, data) {
                    if (valid) {
                        console.log("Valid receipt: " + msg + " / " + data);

                        if (!data.receipt.bid || (data.receipt.bid.toLowerCase() != _kosa.bundle.toLowerCase() && data.receipt.bid.toLowerCase() != _kosa.teambundle.toLowerCase())) {
                            console.log("Invalid bundle ID in receipt: " + data.bid);
                            res.writeHead(471);
                            res.end();
                            return false;
                        }

                        if (!data.receipt.product_id || data.receipt.product_id.toLowerCase().indexOf(_kosa.iap) !== 0) {
                            console.log("Invalid bundle ID in receipt: " + data.bid);
                            res.writeHead(471);
                            res.end();
                            return false;
                        }

                        var lessonNumber = data.receipt.product_id.substr(-2);
                        var exists = false;
                        lessons.forEach(function(l){
                            if (l == lessonNumber) exists = true;
                        })
                        if (!exists) lessons.push(lessonNumber);

                        parseResources({lessons: lessons, auth: params.auth}, res);
                    } else {
                        console.log("Invalid receipt: " + msg + " / " + data);
                        res.writeHead(400);
                        res.end();
                        return false;
                    }
                });
            });

            break;
        case '/l':
            decodeLessons(req, function(lessons, params){
                if (!params.auth) {
                    res.writeHead(403);
                    res.end();
                    return false;
                }

                parseResources({lessons: lessons, auth: params.auth}, res);
            });
            break;
        case '/d':
            decodeLessons(req, function(lessons, params){
                var getParams = {
                    'auth': params.auth,
                    'resource': params.resource,
                    'lessons': lessons
                };

                if (!getParams.auth || !getParams.resource) {
                    res.writeHead(400);
                    res.end();
                    return false;
                }

                var filename = path.join(_kosa.freeResources, getParams.resource);
                fs.exists(filename, function(exists) {
                    if (exists) {
                        res.writeHead(200, mimeTypes[path.extname(filename).split(".")[1]]);
                        fs.createReadStream(filename).pipe(res);
                    } else {
                        filename = path.join(_kosa.paidResources, getParams.resource);
                        fs.exists(filename, function(exists) {
                            if(exists) {
                                res.writeHead(200, mimeTypes[path.extname(filename).split(".")[1]]);
                                fs.createReadStream(filename).pipe(res);
                            } else {
                                console.log("not exists: " + filename);
                                res.writeHead(200, {'Content-Type': 'text/plain'});
                                res.write('404 Not Found\n');
                                res.end();
                                return;
                            }
                        });
                    }
                }); //end path.exists
            });

            break;
        default:
			res.writeHead(400);
			res.end();
			break;
	}
}).listen(_api.port);