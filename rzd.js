/**
 * Client to interact with open RZD API.
 */

(function (angular, console) {
    'use strict';

    var app = angular.module('rzd', ['ngResource']),
        config_injector = angular.injector(['ng', 'rzd_client_config']),
        _slice_ = Array.prototype.slice;


    function _ext_ (heir, ancestor) {
        var Noop = angular.noop;

        Noop.prototype = ancestor.prototype;
        heir.prototype = new Noop();
        heir.superclass = ancestor;
        heir.SC = heir.superclass;
    }


    app.value(
        'SEAT_TYPES',
        ['Плац', 'Купе', 'Люкс', 'Мягкий', 'Сид', 'Общий']
    );

    app.value(
        'SEAT_POSITIONS',
        {
            'Плац': ['up', 'dn', 'lup', 'ldn'],
            'Купе': ['up', 'dn']
        }
   );

    app.value(
        'SEAT_POS_EXPL',
        {
            'Нижние': 'dn',
            'Верхние': 'up',
            'Нижние боковые': 'ldn',
            'Верхние боковые': 'lup'
        }
    );

    app.value(
        'ANY_SEAT',
        'any_seat'
    );

    app.value(
        'RZD_DATE_FORMAT',
        'dd.MM.yyyy'
    );

    app.value(
        'RZD_TIME_FORMAT',
        'HH:mm'
    );

    /**
     * RZD relies on Europe/Moscow.
     */
    app.value('RZD_TZ', '+3000');

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

    app.factory('restoreDict', function () {
        return function (str, skip_enc) {
            var res = {};
            angular.forEach(str.split('&'), function (s) {
                var parts = s.split('=');

                res[parts[0]] = (skip_enc && parts[1]) || decodeURIComponent(parts[1]);
            });

            return res;
        };
    });

    app.service('Watcher', ['encodeDict', 'restoreDict', 'ANY_SEAT',
        function (encodeDict, restoreDict, ANY_SEAT) {
            var Watcher = function (
                train_num,
                dep_time,
                seat_type,
                car_num,
                seat_num,
                seat_pos
            ) {
                this.input = {
                    train_num: train_num,
                    dep_time: dep_time,
                    seat_type: seat_type,
                    car_num: car_num || '',
                    seat_num: seat_num || '',
                    seat_pos: seat_pos || ''
                };

                this.key = encodeDict(this.input, true, true);
                this.status = this.WAITING;
                this.cars_found = null;
            };

            Watcher.parseKey = restoreDict;

            Watcher.fromKey = function (w_key) {
                var o = Watcher.parseKey(w_key);

                if (o) {
                    return new Watcher(
                        o.train_num,
                        o.dep_time,
                        o.seat_type,
                        o.car_num,
                        o.seat_num,
                        o.seat_pos
                    );
                }
            };


            Watcher.prototype.isGreedy = function () {
                return this.input.seat_type === ANY_SEAT;
            };

            Watcher.prototype.isDetailed = function () {
                return (
                    !this.isGreedy() &&
                    (this.input.seat_pos || this.input.car_num || this.seat_num)
                );
            };

            Watcher.prototype.WAITING = 0;
            Watcher.prototype.SUCCEEDED = 1;
            Watcher.prototype.ACCEPTED = 2;
            Watcher.prototype.OUTDATED = 3;

            Watcher.prototype.isWaiting = function () {
                return this.status === this.WAITING;
            };

            Watcher.prototype.isSucceeded = function () {
                return this.status === this.SUCCEEDED;
            };

            Watcher.prototype.isAccepted = function () {
                return this.status === this.ACCEPTED;
            };

            Watcher.prototype.isOutdated = function () {
                return this.status === this.OUTDATED;
            };

            Watcher.prototype.claimSucceeded = function (cars_found) {
                if (!this.isAccepted()) {
                    this.cars_found = cars_found;
                    if (!this.isSucceeded()) {
                        this.status = this.SUCCEEDED;
                        return true;
                    }
                }
            };

            Watcher.prototype.claimOutdated = function () {
                this.status = this.OUTDATED;
            };

            Watcher.prototype.claimFailed = function () {
                if (this.isSucceeded()) {
                    this.status = this.WAITING;
                    this.cars_found = null;
                    return true;
                }
            };

            Watcher.prototype.accept = function () {
                if (this.isSucceeded()) {
                    this.status = this.ACCEPTED;
                    return true;
                }
            };

            Watcher.prototype.restart = function (force) {
                if (this.isAccepted() || force) {
                    this.status = this.WAITING;
                    this.cars_found = null;
                    return true;
                }
            };

            Watcher.prototype.iterateFoundCars = function (callback) {
                if (this.cars_found) {
                    if (!this.isGreedy()) {
                        callback(this.cars_found);
                    } else {
                        angular.forEach(this.cars_found, callback);
                    }
                }
            };

            return Watcher;
        }]
    );

    config_injector.invoke(['GLOBAL_CONFIG', '$window', '$rootScope',
        function (GLOBAL_CONFIG, $window, $rootScope) {

        var task_registry = {},
            connection_state = $rootScope.$new(true),
            directions,
            getWSConnection = (function () {
                var connection;

                return function () {
                    if (connection === undefined) {
                        connection = new WSConstructor();
                    }

                    return connection;
                };
            }());

        connection_state.connected = false;
        connection_state.email_logged_in = undefined;
        connection_state.fallback_enabled = false;

        connection_state.$on('disconnect', function () {
            connection_state.email_logged_in = null;
        });

        function WSConstructor() {
            this.auth_credentials = undefined;
            this.logging_in = false;
            this.connect();
        }

        WSConstructor.ws_on_open = function () {
            connection_state.$apply(function (scope) {
                scope.connected = true;
            });

            angular.forEach(
                this.preconnect_buffer,
                this.send.bind(this)
            );
        };

        WSConstructor.ws_on_message = function (event) {
            var msg = event.data, res, email;

            console.log(msg);

            if (msg.indexOf('login_result') === 0) {
                res = msg.split(' ')[1] === 'success';
                email = this.auth_credentials.email;

                if (res) {
                    connection_state.$apply(function (scope) {
                        scope.email_logged_in = email;
                    });
                } else {
                    connection_state.$emit(
                        'login_failed', email
                    );
                    this.auth_credentials = null;
                }
                this.logging_in = false;
            } else if (msg.indexOf('fallback_enabled') === 0) {
                connection_state.$apply(function (scope) {
                    scope.fallback_enabled = msg.split(' ')[1] === 'yes';
                });
            }else if (msg.indexOf('open_rzd_api') === 0) {
                //pass
            } else {
                connection_state.$emit('incoming_message', msg);
            }
        };

        WSConstructor.ws_on_close = function () {
            console.log("Connection close");

            connection_state.$apply(function (scope) {
                scope.connected = false;
                scope.email_logged_in = undefined;
            });

            this.logging_in = false;
            $window.setTimeout(this.reconnect.bind(this), 5000);
        };

        WSConstructor.prototype.drop = function () {
            if (this.ws) {
                if (this.ws.readyState === this.ws.OPEN) {
                    this.ws.close();
                }
            }
        };

        WSConstructor.prototype.connect = function () {
            if (this.ws) {
                if (this.ws.readyState === this.ws.CLOSED) {
                    delete this.ws;
                } else {
                    return;
                }
            }

            this.preconnect_buffer = [];

            this.ws = new $window.WebSocket(["ws://",
                GLOBAL_CONFIG.api_host,
                GLOBAL_CONFIG.api_prefix,
                "ws"
            ].join(''));

            this.ws.onopen = WSConstructor.ws_on_open.bind(this);
            this.ws.onmessage = WSConstructor.ws_on_message.bind(this);
            this.ws.onclose = WSConstructor.ws_on_close.bind(this);

            this.login();
        };

        WSConstructor.prototype.login = function () {
            if (this.auth_credentials &&
                !connection_state.email_logged_in &&
                !this.logging_in) {
                this.logging_in = true;

                this.send([
                    'login',
                    this.auth_credentials.email,
                    this.auth_credentials.client_name,
                    this.auth_credentials.checking_code
                ].join(' '));
            }
        };

        WSConstructor.prototype.reconnect = function () {
            this.connect();
            connection_state.$emit('reconnect', this);
        };

        WSConstructor.prototype.send = function (msg) {
            console.log('ws => ' + msg);

            if (this.ws.readyState === this.ws.CONNECTING) {
                this.preconnect_buffer.push(msg);
            } else if (this.ws.readyState === this.ws.OPEN) {
                this.ws.send(msg);
            } else {
                throw new Error('web socket is closed');
            }
        };


        app.factory('StationsSuggester', ['$resource',
            function ($resource) {
                return $resource([
                    "http://",
                    GLOBAL_CONFIG.api_host,
                    GLOBAL_CONFIG.api_prefix,
                    "/suggester_proxy?starts_with=:startsWith"
                ].join(''));
            }]
        );

        app.factory('TrackedStationsLookup', ['$resource',
            function ($resource) {
                return $resource(
                    ["http://",
                        GLOBAL_CONFIG.api_host,
                        GLOBAL_CONFIG.api_prefix,
                    "fully_tracked"
                    ].join(''),
                    {},
                    {
                        get: {
                            method: "GET",
                            responseType: "json",
                            interceptor: {
                                response: function (response) {
                                    directions = response.data;
                                    return response.data;
                                }
                            }
                        }
                    }
                );
            }]
        );

        app.factory('RZDLookup', ['$resource',
            function ($resource) {
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
            'RZD_TZ',
            function (
                      $resource,
                      $filter,
                      RZD_DATE_FORMAT,
                      RZD_TIME_FORMAT,
                      RZD_TZ
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
                                for_date = rows[0].key[3];
                                now = Date.now();
                                current_date = $filter('date')(
                                    now, RZD_DATE_FORMAT, RZD_TZ
                                );
                                current_time = $filter('date')(
                                    now, RZD_TIME_FORMAT, RZD_TZ
                                );
                                not_this_day = for_date !== current_date;

                                rows.forEach(function (item) {
                                    if (not_this_day ||
                                        item.value.time0 > current_time) {
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

        app.service('TrackingTask', [
            '$window',
            'Watcher',
            'ANY_SEAT',

            function ($window, Watcher, ANY_SEAT) {
                var LIST = 'list',
                    DETAILS = 'details',
                    TaskInterface,
                    AbstractTask,
                    ListTask,
                    DetailsTask;

               AbstractTask = function (from, to, date) {
                    var key = this.makeKey(_slice_.call(arguments)),
                        instance = TaskInterface.getByKey(key);

                    if (instance) {
                        return instance;
                    }

                    this.input = {
                        from: from,
                        to: to,
                        date: date
                    };
                    this.key = key;

                    if (directions) {
                        this.from = directions.map[from];
                        this.to = directions.map[to];
                    }

                    this.error_proof = true;
                    this.limited = !directions.to[from] || directions.to[from].indexOf(to) == -1;

                    this.watchers = {};

                    this.state = {
                        attempts_done: 0,
                        errors_happened: 0,
                        status: this.IN_PROGRESS
                    };

                    this.result = {
                        trains_found: [],
                        errors: []
                    };
                    this.confirmed = false;

                    task_registry[key] = this;
                };

                AbstractTask.prototype = {
                    IN_PROGRESS: 0,
                    FAILURE: 2,
                    STOPPED: 4,
                    FATAL_FAILURE: 6,
                    TRACKING_ERRORS_LIMIT: 5,
                    type: undefined
                };

                AbstractTask.prototype.makeKey = function(args) {
                    return TaskInterface.makeKey(this.type, args);
                };

                AbstractTask.prototype.recover = function (connection) {
                    var that = this,
                        succeeded_cnt = 0;

                    if (this.isActive()) {
                        console.log("Trying to recover " + this.key);

                        angular.forEach(this.watchers, function (watcher) {
                            if (!watcher.isSucceeded()) {
                                that.pushWatcher(watcher, connection);
                            } else {
                                succeeded_cnt += 1;
                            }
                        });

                        if (this.watchers.length === succeeded_cnt) {
                            this.stop();
                        }
                    }
                };

                AbstractTask.prototype.restart = function () {
                    this.state.status = this.IN_PROGRESS;

                    angular.forEach(
                        this.watchers,
                        function (watcher) {
                            watcher.restart(true);
                        }
                    );
                    this.recover();
                };

                AbstractTask.prototype.restartWatcher = function (watcher) {
                    if (this.watchers[watcher.key] !== undefined) {
                        if (watcher.restart(this.isFailed())) {
                            this.pushWatcher(watcher);
                        }
                    }
                };


                AbstractTask.prototype.addWatcher = function (
                    train_num,
                    dep_time,
                    seat_type,
                    car_num,
                    seat_num,
                    seat_pos
                ) {
                    var w;

                    if (this.limited && seat_type !== ANY_SEAT) {
                        throw 'Inapproperiate watcher';
                    }

                    w = new Watcher(
                        train_num,
                        dep_time,
                        seat_type,
                        car_num,
                        seat_num,
                        seat_pos
                    );

                    if (this.watchers[w.key] === undefined) {
                        this.pushWatcher(w);
                    }
                };

                AbstractTask.prototype.acceptWatcher = function (w) {
                    if (this.watchers[w.key] === undefined) {
                        this.watchers[w.key] = w;
                        return w;
                    }
                };

                AbstractTask.prototype.pushWatcher = function (w, connection) {
                    var args = ['watch', this.key, w.key];

                    if (this.error_proof) {
                        args.push('ignore:NOT_FOUND,NO_SEATS');
                    }

                    connection = connection || getWSConnection();

                    connection.send(args.join(' '));
                };

                AbstractTask.prototype.acceptWatcherExpiration = function (
                    watcher
                ) {
                    var outdated = true;

                    watcher.claimOutdated();
                    angular.forEach(this.watchers, function (watcher) {
                        outdated = outdated && watcher.isOutdated();
                    });

                    if (outdated) {
                        this.state.status = this.FATAL_FAILURE;
                        this.result.errors = [{
                            code: 'OUTDATED',
                            message: 'поезда уже ушли'
                        }];
                    }
                };

                AbstractTask.prototype.acceptWatcherRemoval = function (
                    watcher
                ) {
                    delete this.watchers[watcher.key];

                    if (Object.keys(this.watchers).length === 0) {
                        this.acceptStop(true, 'exhausted');
                    }

                    return watcher;
                };

                AbstractTask.prototype.removeWatcher = function (watcher) {
                    if (watcher.isOutdated() || this.isFailed()) {
                        this.acceptWatcherRemoval(watcher);
                    } else if (this.watchers[watcher.key] !== undefined &&
                        !this.watchers[watcher.key].isSucceeded()) {

                        if (this.isActive() && !watcher.isAccepted()) {
                            getWSConnection().send(
                                ['unwatch', this.key, watcher.key].join(' ')
                            );
                        }
                    }
                };

                AbstractTask.prototype.isFailed = function () {
                    return (this.state.status === this.FAILURE) ||
                            (this.state.status === this.FATAL_FAILURE);
                };

                AbstractTask.prototype.isRecoverable = function () {
                    return this.state.status === this.FAILURE;
                };

                AbstractTask.prototype.isStopped = function () {
                    return this.state.status === this.STOPPED;
                };

                AbstractTask.prototype.isActive = function () {
                    return this.state.status === this.IN_PROGRESS;
                };

                AbstractTask.prototype.stop = function () {
                    if (this.isActive()) {
                        getWSConnection().send(['remove', this.key].join(' '));
                    } else {
                        this.acceptStop(true);
                    }

                    return this;
                };

                AbstractTask.prototype.acceptStop = function (force, reason) {
                    if (!this.isFailed() || force) {
                        this.state.status = this.STOPPED;
                    }

                    if (task_registry[this.key] === this) {
                        delete task_registry[this.key];
                    }

                    if (reason) {
                        this.removal_reason = reason;
                    }

                    connection_state.$emit('task_removed', this);
                };

                AbstractTask.prototype.GRAMMAR = [
                    [
                        /^(\d)(\.|\-)(?:\s(.+))?$/,
                        function (status, prefix, error_json) {
                            this.state.attempts_done += 1;
                            this.state.status = parseInt(status, 10);

                            if (prefix === '-') {
                                this.state.errors_happened += 1;
                            } else {
                                this.state.errors_happened = 0;
                            }

                            if (this.isFailed()) {
                                this.result.errors = angular.fromJson(
                                    error_json
                                );
                                connection_state.$emit('failure', this);
                            }
                        }
                    ],
                    [
                        /^\-W\:(\S+)(?: (dep))?$/,
                        function (watcher_key, dep) {
                            var watcher = this.watchers[watcher_key];

                            if (watcher) {
                                if (dep) {
                                    this.acceptWatcherExpiration(watcher);
                                } else {
                                    this.acceptWatcherRemoval(watcher);
                                }
                            }
                        }
                    ],
                    [
                        /^\+W\:(.+)$/,
                        function (watcher_key) {
                            this.acceptWatcher(Watcher.fromKey(watcher_key));
                        }
                    ],
                    [
                        /^removed(?: ([a-z]+))?$/,
                        function (reason) {
                            this.acceptStop(false, reason);
                        }
                    ],
                    [
                        /^found (.+)$/,
                        function (json_str) {
                            var watchers = angular.fromJson(json_str),
                                succeeded_watchers = [];

                            angular.forEach(
                                watchers,
                                function (task, cars_found, w_key) {
                                    var watcher = task.watchers[w_key];

                                    if (
                                        watcher && watcher.claimSucceeded(
                                            cars_found
                                        )
                                    ) {
                                        succeeded_watchers.push(watcher);
                                    }
                                }.bind(null, this)
                            );

                            if (succeeded_watchers.length > 0) {
                                connection_state.$emit('found', this, succeeded_watchers);
                            }
                        }
                    ],
                    [
                        /^lost (.+)$/,
                        function (json_str) {
                            var data = angular.fromJson(json_str),
                                watchers = [];

                            angular.forEach(data, function (task, w_key) {
                                var watcher = task.watchers[w_key];

                                if (watcher) {
                                    watcher.claimFailed();
                                    watchers.push(watcher);
                                }
                            }.bind(null, this));

                            if (this.onTrainsLost) {
                                this.onTrainsLost(watchers);
                            }
                        }
                    ],
                    [
                        /^details (.+)$/,
                        function (json_str) {
                            var data = JSON.parse(json_str),
                                train_number = data.info.number,
                                dep_time = data.info.time0,
                                train_key = this.makeTrainKey(
                                    train_number, dep_time
                                );

                            this.waiting_for_details = false;
                            angular.forEach(data.accepted, function (w_key) {
                                this.watchers[w_key].accept();
                            });

                            connection_state.$emit(
                                'train_details', this, train_key, data
                            );
                        }
                    ]
                ];

                AbstractTask.prototype.processReport = function (msg) {
                    var re, callback, i, l, res;

                    this.confirmed = true;

                    for (i = 0, l = this.GRAMMAR.length; i < l; i += 1) {
                        re = this.GRAMMAR[i][0];
                        callback = this.GRAMMAR[i][1];
                        res = re.exec(msg);

                        if (res !== null) {
                            callback.apply(this, res.splice(1));
                            return true;
                        }
                    }
                    console.log('not parsed');
                    return false;
                };

                AbstractTask.prototype.askForDetails = function () {
                    throw new Error('Not implemented');
                };

                ListTask = function (from, to, date) {
                    var instance = ListTask.superclass.call(
                        this, from, to, date
                    );

                    if (instance) {
                        return instance;
                    }

                    this.trains = {};
                };

                _ext_(ListTask, AbstractTask);

                ListTask.prototype.type = LIST;

                ListTask.prototype.makeTrainKey = function (
                    train_number, dep_time
                ) {
                    return TaskInterface.makeTrainKey(
                        train_number, this.input.date, dep_time
                    );
                };

                ListTask.prototype.acceptWatcher = function (watcher) {
                    var train, train_key;

                    watcher = ListTask.SC.prototype.acceptWatcher.call(
                        this, watcher
                    );

                    if (watcher) {
                        train_key = this.makeTrainKey(
                            watcher.input.train_num, watcher.input.dep_time
                        );

                        if (this.trains[train_key] === undefined) {
                            this.trains[train_key] = {
                                train_number: watcher.input.train_num,
                                dep_time: watcher.input.dep_time,
                                watchers: [],
                                departured: false,
                                omni: false
                            };
                        }

                        train = this.trains[train_key];
                        watcher.train_key = train_key;

                        train.watchers.push(watcher);
                    }

                    return watcher;
                };

                ListTask.prototype.acceptTrainDeparture = function (train_key) {
                    if (this.trains[train_key]) {
                        this.trains[train_key].departured = true;
                    }
                };

                ListTask.prototype.acceptWatcherExpiration = function (
                    watcher
                ) {
                    ListTask.SC.prototype.acceptWatcherExpiration.call(
                        this, watcher
                    );
                    this.trains[watcher.train_key].departured = true;
                };

                ListTask.prototype.acceptWatcherRemoval = function (
                    watcher
                ) {
                    var train = this.trains[watcher.train_key],
                        train_index = train.watchers.indexOf(watcher);

                    ListTask.SC.prototype.acceptWatcherRemoval.call(
                        this, watcher
                    );

                    if (train_index !== -1) {
                        train.watchers.splice(train_index, 1);
                    }

                    if (train.watchers.length === 0) {
                        delete this.trains[watcher.train_key];
                    }

                    return watcher;
                };

                ListTask.prototype.removeTrainByKey = function (train_key) {
                    if (this.trains[train_key]) {
                        angular.forEach(
                            this.trains[train_key].watchers,
                            ListTask.SC.prototype.removeWatcher.bind(this)
                        );
                    }

                    delete this.trains[train_key];
                };

                ListTask.prototype.askForDetails = function (
                    train_number, dep_time
                ) {
                    var train_key = this.makeTrainKey(
                            train_number, dep_time
                        );

                    angular.forEach(
                        this.trains[train_key].watchers,
                        function (watcher) {
                            watcher.accept();
                        }
                    );

                    if (this.trains[train_key]) {
                        getWSConnection().send(
                            [
                                'get_details',
                                this.key,
                                train_number,
                                dep_time
                            ].join(' ')
                        );
                        this.waiting_for_details = true;
                    } else {
                        console.warn(train_key);
                    }
                };

                ListTask.prototype.getTrainsCount = function () {
                    return Object.keys(this.trains).length;
                };

                ListTask.prototype.GRAMMAR = ListTask.prototype.GRAMMAR.slice();
                ListTask.prototype.GRAMMAR.push(
                    [
                        /^vanished (\S+) (\d{2}:\d{2})$/,
                        function (train_number, dep_time) {
                            var train_key = this.makeTrainKey(
                                    train_number, dep_time
                                );

                            this.waiting_for_details = false;

                            angular.forEach(
                                this.trains[train_key].watchers,
                                function (watcher) {
                                    if (watcher.isAccepted()) {
                                        watcher.restart();
                                    }
                                }
                            );
                        }
                    ]
                );

                DetailsTask = function (from, to, date, train, time) {
                    var instance = ListTask.superclass.call(
                        this, from, to, date, train, time
                    );

                    if (instance) {
                        return instance;
                    }

                    this.train = train;
                    this.dep_time = time;
                    this.list_key = TaskInterface.makeKey(LIST, [from, to, date]);
                    this.train_key = this.makeTrainKey();
                };

                _ext_(DetailsTask, AbstractTask);

                DetailsTask.prototype.type = DETAILS;
                DetailsTask.prototype.GRAMMAR = DetailsTask.prototype.GRAMMAR.slice();

                DetailsTask.prototype.GRAMMAR.push(
                    [
                        /^vanished (\S+) (\d{2}:\d{2})$/,
                        function (train_number, dep_time) {
                            this.waiting_for_details = false;

                            angular.forEach(
                                this.watchers,
                                function (watcher) {
                                    if (watcher.isAccepted()) {
                                        watcher.restart();
                                    }
                                }
                            );
                        }
                    ]
                );

                DetailsTask.prototype.makeTrainKey = function () {
                    return TaskInterface.makeTrainKey(
                        this.train, this.input.date, this.dep_time
                    );
                };

                DetailsTask.prototype.askForDetails = function () {
                    angular.forEach(
                        this.watchers,
                        function (watcher) {
                            watcher.accept();
                        }
                    );

                    getWSConnection().send(
                        [
                            'get_details',
                            this.key,
                            this.train,
                            this.dep_time
                        ].join(' ')
                     );
                    this.waiting_for_details = true;
                };

                DetailsTask.prototype.acceptWatcherExpiration = function (
                    watcher
                ) {
                    DetailsTask.SC.prototype.acceptWatcherExpiration.call(
                        this, watcher
                    );
                    this.state.status = this.FATAL_FAILURE;
                    this.result.errors = [{
                        code: 'OUTDATED',
                        message: 'поезд уже ушел'
                    }];
                };

                DetailsTask.prototype.GRAMMAR = DetailsTask.prototype.GRAMMAR.slice();
                DetailsTask.prototype.GRAMMAR.push(
                    [
                        /^vanished (\S+) (\d{2}:\d{2})$/,
                        function (train_number, dep_time) {
                            this.waiting_for_details = false;

                            angular.forEach(
                                this.watchers,
                                function (watcher) {
                                    if (watcher.isAccepted()) {
                                        watcher.restart();
                                    }
                                }
                            );
                        }
                    ]
                    //connection_state.$emit('dep', this, this.train_key);
                );

                TaskInterface = {
                    getByKey: function (key) {
                        return task_registry[key];
                    },

                    makeKey: function (type, args) {
                        args.unshift(type);
                        return args.join(',');
                    },

                    makeTrainKey: function (
                        train_number, dep_date, dep_time
                    ) {
                        return [dep_date, dep_time, train_number].join('_');
                    },

                    parseKey: function (key) {
                        var parts = key.split(','),
                            type = parts.shift();

                        if (type === LIST) {
                            if (parts.length !== 3) {
                                throw new Error('wrong task key: ' + key);
                            }
                        } else if (type === DETAILS) {
                            if (parts.length !== 5) {
                                throw new Error('wrong task key: ' + key);
                            }
                        } else {
                            throw new Error('unknown task type: ' + type);
                        }

                        return {
                            type: type,
                            args: parts
                        };
                    },

                    create: function (type, from, to, date, train, time) {
                        from = Number(from);
                        to = Number(to);

                        if (type === LIST) {
                            return new ListTask(from, to, date);
                        } else if (type === DETAILS) {
                            return new DetailsTask(from, to, date, train, time);
                        }
                    },

                    getOrCreateByKey: function (key) {
                        var task = TaskInterface.getByKey(key), o, a;

                        if (!task) {
                            try {
                                o = TaskInterface.parseKey(key);
                            } catch (e) {
                                console.error(e);
                            }

                            if (o) {
                                a = o.args;
                                a.unshift(o.type);

                                task = TaskInterface.create.apply(null, a);

                                connection_state.$emit('task_emerge', task);
                            }
                        } else if (!task.confirmed) {
                            connection_state.$emit('task_emerge', task);
                        }

                        return task;
                    },

                    callAll: function (callback) {
                        angular.forEach(task_registry, callback);
                    },

                    track: function(
                        from,
                        to,
                        date,
                        train_num,
                        dep_time,
                        seat_type,
                        car_num,
                        seat_num,
                        seat_pos
                    ) {
                        var task, type = LIST;

                        if (train_num && (car_num || seat_num || seat_pos)) {
                            type = DETAILS;
                        }

                        task = this.create(type, from, to, date, train_num, dep_time);

                        task.addWatcher(
                            train_num,
                            dep_time,
                            seat_type,
                            car_num,
                            seat_num,
                            seat_pos
                        );

                        return task;
                    }
                };

                connection_state.$on('reconnect', function (event) {
                    var connection = getWSConnection();

                    TaskInterface.callAll(function (task) {
                        task.recover(connection);
                    });
                });

                connection_state.$on('incoming_message', function (event, msg) {
                    var parts = msg.split(' '),
                        task_key = parts.shift(),
                        task = TaskInterface.getOrCreateByKey(task_key);

                    if (task) {
                        event.task_report = task.processReport(parts.join(' '));
                    }
                });

                return TaskInterface;
            }
        ]);

        app.service('watchWSState', function () {
            return function (expr, callback) {
                connection_state.$watch(expr, callback);
            };
        });

        app.service('listenToWS', function () {
            return function (event_name, callback) {
                connection_state.$on(event_name, callback);
            };
        });

        app.service('CYTConnect', function () {
            return function (email, client_name, checking_code) {
                var conn = getWSConnection();

                conn.auth_credentials = {
                    email: email,
                    checking_code: checking_code,
                    client_name: client_name
                };

                if (!connection_state.connected) {
                    conn.login();
                } else {
                    conn.drop();
                }
            };
        });

        app.service('CYTToggleFallback', function () {
            return function (email, checking_code) {
                var conn;

                if (connection_state.email_logged_in) {
                    conn = getWSConnection();
                    conn.send([
                        'fallback',
                        connection_state.fallback_enabled ? 'disable' : 'enable'
                    ].join(' '));
                }
            };
        });
    }]);

    return app;
}(angular, console));
