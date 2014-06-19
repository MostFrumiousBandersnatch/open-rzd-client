/**
 * Client to interact with open RZD API.
 */

(function (angular) {
    'use strict';

    var app = angular.module('rzd', ['ngResource', 'rzd_client_config']);

    app.value(
        'SEAT_TYPES',
        ['Плац', 'Купе', 'Люкс', 'Сид']
    );

    app.value(
        'RZD_DATE_FORMAT',
        'dd.MM.yyyy'
    );

    app.value(
        'RZD_TIME_FORMAT',
        'HH:mm'
    );

    app.factory('stationsSuggester', ['$resource', 'GLOBAL_CONFIG',
        function ($resource, GLOBAL_CONFIG) {
            return $resource([
                "http://",
                GLOBAL_CONFIG.api_host,
                GLOBAL_CONFIG.api_prefix,
                "/suggester_proxy?starts_with=:startsWith"
            ].join(''));
        }]
    );

    app.factory('trackedStationsLookup', ['$resource', 'GLOBAL_CONFIG',
        function ($resource, GLOBAL_CONFIG) {
            return $resource(["http://",
                GLOBAL_CONFIG.api_host,
                GLOBAL_CONFIG.api_prefix,
                "fully_tracked"
            ].join(''));
        }]
    );

    app.factory('RZDLookup', ['$resource', 'GLOBAL_CONFIG',
        function ($resource, GLOBAL_CONFIG) {
            return $resource(
                [
                    "http://",
                    GLOBAL_CONFIG.api_host,
                    GLOBAL_CONFIG.api_prefix,
                    "fetch/:kind"
                ].join(''),
                null,
                {
                    fetchList: {
                        method: 'GET',
                        params: {kind: 'list'},
                        responseType: "json"
                    },
                    fetchDetails: {
                        method: 'GET',
                        params: {kind: 'detail'},
                        responseType: "json"
                    }
                }
            );
        }]
    );

    app.factory('StorageLookup', [
        '$resource',
        '$filter',
        'RZD_DATE_FORMAT',
        'RZD_TIME_FORMAT',
        'GLOBAL_CONFIG',
        function (
                  $resource,
                  $filter,
                  RZD_DATE_FORMAT,
                  RZD_TIME_FORMAT,
                  GLOBAL_CONFIG
        ) {
            return $resource(["http://",
                GLOBAL_CONFIG.api_host,
                GLOBAL_CONFIG.storage_prefix,
                'fetch/:kind'
            ].join(''), null, {
                fetchList: {
                    method: 'GET',
                    params: {kind: 'list'},
                    responseType: "json",
                    isArray: true,
                    transformResponse: function (data) {
                        var rows = data.rows,
                            for_date, now, current_date, current_time,
                            not_this_day,
                            result = [];

                        if (rows.length > 0) {
                            for_date = rows[0].key[2];
                            now = Date.now();
                            current_date = $filter('date')(
                                now, RZD_DATE_FORMAT
                            );
                            current_time = $filter('date')(
                                now, RZD_TIME_FORMAT
                            );
                            not_this_day = for_date !== current_date;

                            rows.forEach(function (item) {
                                if (not_this_day || item.value.time0 > current_time) {
                                    result.push(item.value);
                                }
                            });
                        }

                        return result;
                    }
                },
                fetchDetails: {
                    method: 'GET',
                    params: {kind: 'detail'},
                    responseType: "json"
                }
            });
        }
    ]);

    app.factory('encodeDict', function () {
        return function (o, skip_enc, skip_empty_items) {
            var key, res = [];

            for (key in o) {
                if (o.hasOwnProperty(key) && (!skip_empty_items || o[key])) {
                    res.push([
                        encodeURIComponent(key),
                        (skip_enc && o[key] || encodeURIComponent(o[key]))
                    ].join('='));
                }
            }

            return res.join('&');
        };
    });

    app.service('trackingTask', [
        '$window',
        'encodeDict',
        'GLOBAL_CONFIG',

        function ($window, encodeDict, GLOBAL_CONFIG) {
            var task_registry = {},
                getWSConnection,
                Watcher,
                Task;

            getWSConnection = (function () {
                var connection;

                function WSConstructor() {
                    this.connect();
                }

                WSConstructor.prototype.connect = function () {
                    var reconnect = this.reconnect.bind(this);

                    if (this.ws) {
                        if (this.ws.readyState === this.ws.CLOSED) {
                            delete this.ws;
                        } else {
                            return;
                        }
                    }

                    this.ws = new $window.WebSocket(["ws://",
                            GLOBAL_CONFIG.api_host,
                            GLOBAL_CONFIG.api_prefix,
                            "ws"
                        ].join(''));


                    this.ws.onmessage = function () {
                        var msg = event.data,
                            parts = msg.split(' '),
                            task_key = parts.shift(),
                            task = Task.getByKey(task_key);

                        console.log('ws <= ' + msg);

                        if (task) {
                            task.processReport(parts.join(' '));
                        }
                    };

                    this.ws.onclose = function () {
                        console.log("Connection close");
                        $window.setTimeout(reconnect, 5000);
                    };
                };

                WSConstructor.prototype.reconnect = function () {
                    var that = this;

                    this.connect();

                    Task.getAll(function (task) {
                        task.recover(that);
                    });
                };

                WSConstructor.prototype.send = function (msg) {
                    console.log('ws => ' + msg);

                    if (this.ws.readyState === this.ws.CONNECTING) {
                        this.ws.addEventListener('open', function () {
                            this.send(msg);
                        });
                    } else if (this.ws.readyState === this.ws.OPEN) {
                        this.ws.send(msg);
                    } else {
                        throw new Error('web socket is closed');
                    }
                };

                return function () {
                    if (connection === undefined) {
                        connection = new WSConstructor();
                    }

                    return connection;
                };
            }());

            Watcher = function (
                train_num,
                seat_type,
                car_num,
                seat_num,
                seat_pos
            ) {
                this.input = {};

                this.input.train_num = train_num;
                this.input.seat_type = seat_type;
                this.input.car_num = car_num || '';
                this.input.seat_num = seat_num || '';
                this.input.seat_pos = seat_pos || '';

                this.key = encodeDict(this.input, true, true);
                this.succeeded = false;
            };

            Watcher.prototype.claim_success = function () {
                this.succeeded = true;
                this.success_time = (new Date()).toLocaleTimeString();
            };

            Task = function (from, to, date, s_from, s_to) {
                var key = [this.TYPE, from, to, date].join(','),
                    instance = Task.getByKey(key);

                if (instance) {
                    return instance;
                }

                this.input = {
                    from: from,
                    to: to,
                    date: date
                };
                this.key = key;

                this.from = s_from;
                this.to = s_to;

                this.watchers = {};

                this.state = {
                    attempts_done: 0,
                    errors_happened: 0,
                    status: this.IN_PROGRESS,
                    waiting_for_result: false
                };

                this.result = {
                    trains_found: [],
                    errors: []
                };

                task_registry[key] = this;
            };

            Task.getByKey = function (key) {
                return task_registry[key];
            };

            Task.getAll = function (callback) {
                angular.forEach(task_registry, callback);
            };

            Task.prototype = {
                IN_PROGRESS: 0,
                FAILURE: 2,
                STOPPED: 4,
                TRACKING_ERRORS_LIMIT: 5,
                TYPE: 'list'
            };

            Task.prototype.recover = function (connection) {
                var that = this,
                    succeeded_cnt = 0;

                if (this.isActive()) {
                    console.log("Trying to recover " + this.key);

                    angular.forEach(this.watchers, function (watcher) {
                        if (!watcher.succeeded) {
                            that._addWatcher(watcher, connection);
                        } else {
                            succeeded_cnt += 1;
                        }
                    });

                    if (this.watchers.length === succeeded_cnt) {
                        this.stop();
                    }
                }
            };

            Task.prototype.addWatcher = function (
                train_num,
                seat_type,
                car_num,
                seat_num,
                seat_pos
            ) {
                var w = new Watcher(
                    train_num,
                    seat_type,
                    car_num,
                    seat_num,
                    seat_pos
                );

                if (this.watchers[w.key] === undefined) {
                    this.watchers[w.key] = w;
                    this._addWatcher(w);
                }

                return this.watchers[w.key];
            };

            Task.prototype._addWatcher = function (w, connection) {
                connection = connection || getWSConnection();
                connection.send(['watch', this.key, w.key].join(' '));
            };

            Task.prototype.removeWatcher = function (w_key, hardly) {
                if (this.watchers[w_key] !== undefined) {
                    if (hardly) {
                        delete this.watchers[w_key];
                    }
                    getWSConnection().send(
                        ['unwatch', this.key, w_key].join(' ')
                    );
                }
            };

            Task.prototype.isFailured = function () {
                return this.state.status === this.FAILURE;
            };

            Task.prototype.isStopped = function () {
                return this.state.status === this.STOPPED;
            };

            Task.prototype.isActive = function () {
                return this.state.status === this.IN_PROGRESS;
            };

            Task.prototype.stop = function () {
                this.state.status = this.STOPPED;
                getWSConnection().send(['remove', this.key].join(' '));
                delete task_registry[this.key];
                return this;
            };

            Task.prototype.inconsiderableMsgTmpl = new RegExp(
                '^(\\+W|\\-W|stopped)'
            );

            Task.prototype.processReport = function (msg) {
                var that = this,
                    data;

                if (!this.inconsiderableMsgTmpl.test(msg)) {
                    if (this.state.waiting_for_result) {
                        this.state.waiting_for_result = false;
                        data = JSON.parse(msg);

                        angular.forEach(data, function (train_data, train_num) {
                            angular.forEach(train_data, function (v, w_key) {
                                console.log(w_key);
                                that.watchers[w_key].claim_success();
                                //watchers being removed on server automatically
                                //at a moment of success
                                //that.removeWatcher(w_key);
                            });

                            if (this.on_success) {
                                this.on_success(train_num, train_data);
                            }
                        });
                    } else if (this.isFailured()) {
                        this.result.errors = JSON.parse(msg);
                    } else if (msg.length === 2) {
                        this.state.status = parseInt(msg[0], 10);
                        if (msg[1] === '-') {
                            this.state.errors_happened += 1;
                        } else if (msg[1] === '!') {
                            this.state.waiting_for_result = true;
                        } else {
                            this.state.errors_happened = 0;
                        }
                        this.state.attempts_done += 1;
                    }
                }

                if (this.onUpdate) {
                    this.onUpdate();
                }
            };

            return Task;
        }
    ]);

    return app;
}(angular));
