/**
 * Client to interact with open RZD API.
 */

(function (angular, console) {
    'use strict';

    var app = angular.module('rzd', ['ngResource']),
        config_injector = angular.injector(['ng', 'rzd_client_config']);

    app.value(
        'SEAT_TYPES',
        ['Плац', 'Купе', 'Люкс', 'Сид', 'Общий']
    );

    app.value(
        'SEAT_POSITIONS',
        {
            'Плац': ['up', 'dn', 'lup', 'ldn'],
            'Купе': ['up', 'dn']
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

            Watcher.prototype.isGreedy = function () {
                return this.input.seat_type === ANY_SEAT;
            };

            Watcher.prototype.WAITING = 0;
            Watcher.prototype.SUCCEEDED = 1;
            Watcher.prototype.ACCEPTED = 2;

            Watcher.prototype.isWaiting = function () {
                return this.status === this.WAITING;
            };

            Watcher.prototype.isSucceeded = function () {
                return this.status === this.SUCCEEDED;
            };

            Watcher.prototype.isAccepted = function () {
                return this.status === this.ACCEPTED;
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
            forked_task_registry = {},
            connection_state = $rootScope.$new(true),
            directions,
            getWSConnection = (function (requesting_task) {
                var connection;

                return function () {
                    if (connection === undefined) {
                        connection_state.$apply(function (scope) {
                            scope.task_class = requesting_task;
                        });
                        connection = new WSConstructor();
                    }

                    return connection;
                };
            }());

        connection_state.connected = false;
        connection_state.email_logged_in = undefined;
        connection_state.fallback_enabled = false;
        connection_state.task_class = undefined;

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
                //CPI.report_auth_success(res);
            } else if (msg.indexOf('open_rzd_api') === 0) {
                //pass
            } else {
                connection_state.$emit('incoming_message', msg);
            }
        };

        WSConstructor.ws_on_close = function () {
            console.log("Connection close");

            connection_state.$apply(function (scope) {
                scope.connected = false;
            });

            this.logging_in = false;
            $window.setTimeout(this.reconnect.bind(this), 5000);
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
            function (
                      $resource,
                      $filter,
                      RZD_DATE_FORMAT,
                      RZD_TIME_FORMAT
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
                                    now, RZD_DATE_FORMAT
                                );
                                current_time = $filter('date')(
                                    now, RZD_TIME_FORMAT
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
                var Task = function (
                    from,
                    to,
                    date,
                    error_proof,
                    limited
                ) {
                    var key = Task.makeKey(from, to, date),
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

                    if (directions) {
                        this.from = directions.map[from];
                        this.to = directions.map[to];
                    }


                    this.error_proof = error_proof || false;

                    this.watchers = {};
                    this.limited = Boolean(limited);

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

                Task.makeKey = function (from, to, date) {
                    return [this.prototype.TYPE, from, to, date].join(',');
                };

                Task.getByKey = function (key) {
                    return task_registry[key] || forked_task_registry[key];
                };

                Task.parseKey = function (key) {
                    var parts = key.split(',');

                    if (parts.length !== 4) {
                        throw new Error('wrong task key');
                    }

                    return {
                        type: parts[0],
                        from: parts[1],
                        to: parts[2],
                        date: parts[3]
                    };
                };

                Task.getOrCreateByKey = function (key) {
                    var task = Task.getByKey(key), o;

                    if (!task) {
                        try {
                            o = Task.parseKey(key);
                        } catch (e) {
                            console.error(e);
                        }

                        if (o) {
                            task = new connection_state.task_class(
                                o.from, o.to, o.date
                            );

                            connection_state.$emit('task_emerge', task);
                        }
                    } else if (!task.confirmed) {
                        connection_state.$emit('task_emerge', task);
                    }

                    return task;
                };

                Task.getAll = function (callback) {
                    angular.forEach(task_registry, callback);
                };

                Task.prototype = {
                    IN_PROGRESS: 0,
                    FAILURE: 2,
                    STOPPED: 4,
                    FATAL_FAILURE: 6,
                    TRACKING_ERRORS_LIMIT: 5,
                    TYPE: 'list'
                };

                Task.prototype.recover = function (connection) {
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

                connection_state.$on('reconnect', function (event) {
                    var connection = getWSConnection();

                    Task.getAll(function (task) {
                        task.recover(connection);
                    });
                });

                Task.prototype.restart = function () {
                    this.state.status = this.IN_PROGRESS;
                    angular.forEach(
                        this.watchers,
                        function (watcher) {
                            watcher.restart(true);
                        }
                    );
                    this.recover();
                };

                Task.prototype.restartWatcher = function (watcher) {
                    if (this.watchers[watcher.key] !== undefined) {
                        if (watcher.restart(this.isFailed())) {
                            this.pushWatcher(watcher);
                        }
                    }
                };


                Task.prototype.addWatcher = function (
                    train_num,
                    dep_time,
                    seat_type,
                    car_num,
                    seat_num,
                    seat_pos,
                    silently
                ) {
                    var w;

                    if (this.limited  && seat_type !== ANY_SEAT) {
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
                        this.watchers[w.key] = w;
                        if (!silently) {
                            this.pushWatcher(w);
                        }
                    }

                    return this.watchers[w.key];
                };

                Task.prototype.pushWatcher = function (w, connection) {
                    var args = ['watch', this.key, w.key];

                    if (this.error_proof) {
                        args.push('ignore:NOT_FOUND');
                    }

                    connection = connection || getWSConnection();

                    connection.send(args.join(' '));
                };

                Task.prototype.removeWatcher = function (watcher) {
                    if (this.watchers[watcher.key] !== undefined &&
                        !this.watchers[watcher.key].isSucceeded()) {
                        delete this.watchers[watcher.key];

                        if (this.isActive() && !watcher.isAccepted()) {
                            getWSConnection().send(
                                ['unwatch', this.key, watcher.key].join(' ')
                            );
                        }

                        if (Object.keys(this.watchers).length === 0) {
                            this.stop();
                        }
                    }
                };

                Task.prototype.isFailed = function () {
                    return (this.state.status === this.FAILURE) ||
                            (this.state.status === this.FATAL_FAILURE);
                };

                Task.prototype.isRecoverable = function () {
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

                Task.prototype.GRAMMAR = [
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
                                if (this.onFailure) {
                                    this.onFailure();
                                }
                            }
                        }
                    ],
                    [
                        /^\+W|\-W|stopped|has been scheduled/,
                        angular.noop
                    ],
                    [
                        /^found (.+)$/,
                        function (json_str) {
                            var watchers = angular.fromJson(json_str),
                                watchers_got_succeeded = [];

                            angular.forEach(
                                watchers,
                                function (task, cars_found, w_key) {
                                    var watcher = task.watchers[w_key];

                                    if (
                                        watcher && watcher.claimSucceeded(
                                            cars_found
                                        )
                                    ) {
                                        watchers_got_succeeded.push(watcher);
                                    }
                                }.bind(null, this)
                            );

                            if (watchers_got_succeeded.length > 0 &&
                                this.onSuccess) {
                                this.onSuccess(
                                    watchers_got_succeeded
                                );
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
                        /^fork (.+)$/,
                        function (forked_task_key) {
                            forked_task_registry[forked_task_key] = this;
                        }
                    ],
                    [
                        /^fallback_enabled (yes|no)$/,
                        function (fallback_enabled) {
                            this.fallback = fallback_enabled === 'yes';
                        }
                    ],
                    [
                        /^restore_watcher (.+)$/,
                        function (watcher_key) {
                            var o = Watcher.parseKey(watcher_key);

                            this.addWatcher(
                                o.train_num,
                                o.dep_time,
                                o.seat_type,
                                o.car_num,
                                o.seat_num,
                                o.seat_pos,
                                true
                            );
                        }
                    ]
                ];

                Task.prototype.processReport = function (msg) {
                    var re, callback, i, l, res;

                    this.confirmed = true;

                    for (i = 0, l = this.GRAMMAR.length; i < l; i += 1) {
                        re = this.GRAMMAR[i][0];
                        callback = this.GRAMMAR[i][1];
                        res = re.exec(msg);

                        if (res !== null) {
                            callback.apply(this, res.splice(1));

                            if (this.onUpdate) {
                                this.onUpdate();
                            }
                            return;
                        }
                    }
                    console.log('not parsed');
                };

                connection_state.$on('incoming_message', function (event, msg) {
                    var parts = msg.split(' '),
                        task_key = parts.shift(),
                        task = Task.getOrCreateByKey(task_key);

                    if (task) {
                        task.processReport(parts.join(' '));
                    }
                });
                //CPI.incoming_hooks.push();

                return Task;
            }
        ]);

        app.service(
            'TrackingTaskPlus',
            [
                'TrackingTask', 'ANY_SEAT',
                /**
                 * A Tracking task subclass awared about trains.
                 */
                function (TrackingTask, ANY_SEAT) {
                    var Noop = angular.noop,
                        TaskPlus = function (
                            from, to, date, error_proof, limited
                        ) {
                            var instance = TaskPlus.superclass.call(
                                this, from, to, date, error_proof, limited
                            );

                            if (instance) {
                                return instance;
                            }

                            this.trains = {};
                        };

                    Noop.prototype = TrackingTask.prototype;
                    TaskPlus.prototype = new Noop();
                    TaskPlus.prototype.constructor = TaskPlus;
                    TaskPlus.superclass = TrackingTask;
                    TaskPlus.SC = TaskPlus.superclass;

                    angular.forEach(
                        TrackingTask,
                        function (prop, name) {
                            TaskPlus[name] = prop;
                        }
                    );

                    TaskPlus.generateTrainKey = function (
                        train_number, dep_date, dep_time
                    ) {
                        return [dep_date, dep_time, train_number].join('_');
                    };

                    TaskPlus.prototype.makeTrainKey = function (
                        train_number, dep_time
                    ) {
                        return TaskPlus.generateTrainKey(
                            train_number, this.input.date, dep_time
                        );
                    };

                    TaskPlus.prototype.addWatcher = function (
                        train_num,
                        dep_time,
                        seat_type,
                        car_num,
                        seat_num,
                        seat_pos,
                        silently
                    ) {
                        var watcher = TaskPlus.SC.prototype.addWatcher.call(
                            this,
                            train_num,
                            dep_time,
                            seat_type,
                            car_num,
                            seat_num,
                            seat_pos,
                            silently
                        ),
                        train,
                        train_key = this.makeTrainKey(train_num, dep_time);

                        if (this.trains[train_key] === undefined) {
                            this.trains[train_key] = {
                                train_number: train_num,
                                dep_time: dep_time,
                                watchers: [],
                                departured: false,
                                omni: false
                            };
                        }

                        train = this.trains[train_key];
                        watcher.train_key = train_key;

                        train.watchers.push(watcher);

                        return watcher;
                    };

                    TaskPlus.prototype.onDeparture = function (data) {
                        angular.forEach(
                            data,
                            function (dep_time, train_number) {
                                var train_key = this.makeTrainKey(
                                    train_number, dep_time
                                );

                                if (this.trains[train_key]) {
                                    this.trains[train_key].departured = true;
                                } else {
                                    console.warn(train_key);
                                }
                            }.bind(this)
                        );
                    };

                    TaskPlus.prototype.removeWatcher = function (watcher) {
                        var train = this.trains[watcher.train_key],
                            train_index = train.watchers.indexOf(watcher),
                            result = TaskPlus.SC.prototype.removeWatcher.call(
                                this, watcher
                            );

                        if (train_index !== -1) {
                            train.watchers.splice(train_index, 1);
                        }

                        if (train.watchers.length === 0) {
                            delete this.trains[watcher.train_key];
                        }

                        return result;
                    };

                    TaskPlus.prototype.removeTrainByKey = function (train_key) {
                        if (this.trains[train_key]) {
                            angular.forEach(
                                this.trains[train_key].watchers,
                                TaskPlus.SC.prototype.removeWatcher.bind(this)
                            );
                        }

                        delete this.trains[train_key];
                    };

                    TaskPlus.prototype.askForDetails = function (
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

                    TaskPlus.prototype.getTrainsCount = function () {
                        return Object.keys(this.trains).length;
                    };

                    TaskPlus.prototype.GRAMMAR.push(
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

                                if (this.onTrainDetails) {
                                    this.onTrainDetails(train_key, data);
                                }
                            }
                        ],
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
                        ],
                        [
                            /^dep (.+)$/,
                            function (json_str) {
                                var data = JSON.parse(json_str);

                                angular.forEach(
                                    data,
                                    function (dep_time, train_number) {
                                        var train_key = this.makeTrainKey(
                                            train_number, dep_time
                                        );

                                        if (this.trains[train_key]) {
                                            this.trains[
                                                train_key
                                            ].departured = true;

                                            if (this.onTrainDeparture) {
                                                this.onTrainDeparture(
                                                    train_key
                                                );
                                            }
                                        } else {
                                            console.warn(train_key);
                                        }
                                    }.bind(this)
                                );
                            }
                        ]
                    );

                    return TaskPlus;
                }
            ]
        );


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
            return function (email, checking_code) {
                var conn = getWSConnection();

                conn.auth_credentials = {
                    email: email,
                    checking_code: checking_code
                };
                conn.login();
            };
        });
    }]);

    return app;
}(angular, console));
