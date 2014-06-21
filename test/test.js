'use strict';

/*global jasmine, describe, it, beforeEach, afterEach, module,
    expect, inject, spyOn
*/

describe('RZD open API client', function () {
    beforeEach(function () {
        module('rzd');
    });

    describe('encodeDict', function () {
        var encodeDictFactory;

        beforeEach(inject(
            function (encodeDict) {
                encodeDictFactory = encodeDict;
            }
        ));

        it('should exists',
            function () {
                expect(encodeDictFactory).toBeDefined();
            }
        );

        it('should performs serialization',
            function () {
                var source = {
                        a: 1,
                        b: 'M&Ms'
                    },
                    serialized = 'a=1&b=M%26Ms';

                expect(encodeDictFactory(source)).toEqual(serialized);
            }
        );

        it('should performs serialization without encoding as well',
            function () {
                var source = {
                        a: 'привет',
                        b: 'пока'
                    },
                    serialized = 'a=привет&b=пока';

                expect(encodeDictFactory(source, true)).toEqual(serialized);
            }
        );

        it('should skip empty items in case',
            function () {
                var source = {
                        a: 1,
                        b: '',
                        c: 3
                    },
                    fully_serialized = 'a=1&b=&c=3',
                    mostly_serialized = 'a=1&c=3';

                expect(encodeDictFactory(source)).toEqual(fully_serialized);
                expect(encodeDictFactory(source, false, true)).toEqual(
                    mostly_serialized
                );
            }
        );
    });

    describe('StorageLookup', function () {
        var $httpBackend,
            StorageLookup,
            GlobalConfig;

        beforeEach(function () {
            module('rzd_client_config');
            module('fixtures');

            inject(function ($injector) {
                $httpBackend = $injector.get('$httpBackend');
                StorageLookup = $injector.get('StorageLookup');
                GlobalConfig = $injector.get('GLOBAL_CONFIG');
            });


        });

        it('should call the right URL and return an array',
            function () {
                var response;

                $httpBackend.expectGET(
                    'http://' +
                    GlobalConfig.api_host +
                    GlobalConfig.storage_prefix +
                    'fetch/list?date=01.01.2015&from=200000&to=200400'
                ).respond({rows: []});

                response = StorageLookup.fetchList({
                    from: 200000,
                    to: 200400,
                    date: '01.01.2015'
                });

                $httpBackend.flush();

                expect(angular.isArray(response)).toBeTruthy();
                expect(response.length).toEqual(0);
            }
        );

        it('should not return list of trains',
            inject(function ($templateCache) {
                var response;

                $httpBackend.expectGET(
                    'http://' + GlobalConfig.api_host +
                    GlobalConfig.storage_prefix +
                    'fetch/list?date=22.06.2014&from=200000&to=2060150'
                ).respond(
                    JSON.parse(
                        $templateCache.get('moscow_to_izh_22.06_stored.json')
                    )
                );

                spyOn(Date, 'now').andReturn(
                    new Date(2014, 5, 22, 15, 0, 0)
                );

                response = StorageLookup.fetchList({
                    from: 200000,
                    to: 2060150,
                    date: '22.06.2014'
                });

                $httpBackend.flush();

                expect(angular.isArray(response)).toBeTruthy();
                expect(response.length).toEqual(2);
                expect(response[0].number).toEqual("026Г");
                expect(response[1].number).toEqual("131Г");
            })
        );

        it('should not return trains already departured',
            inject(function ($templateCache) {
                var response;

                $httpBackend.expectGET(
                    'http://' + GlobalConfig.api_host +
                    GlobalConfig.storage_prefix +
                    'fetch/list?date=22.06.2014&from=200000&to=2060150'
                ).respond(
                    JSON.parse(
                        $templateCache.get('moscow_to_izh_22.06_stored.json')
                    )
                );

                spyOn(Date, 'now').andReturn(
                    new Date(2014, 5, 22, 19, 0, 0)
                );

                response = StorageLookup.fetchList({
                    from: 200000,
                    to: 2060150,
                    date: '22.06.2014'
                });

                $httpBackend.flush();

                expect(angular.isArray(response)).toBeTruthy();
                expect(response.length).toEqual(1);
                expect(response[0].number).toEqual("131Г");
            })
        );
    });
});
