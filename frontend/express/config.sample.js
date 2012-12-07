var countlyConfig = {};

countlyConfig.mongodb = {};
countlyConfig.web = {};

countlyConfig.mongodb.host = "localhost";
countlyConfig.mongodb.db = "countly";
countlyConfig.mongodb.port = 27017;
//countlyConfig.mongodb.user = "countly";
//countlyConfig.mongodb.password = "password";

countlyConfig.web.port = 6001;

module.exports = countlyConfig;