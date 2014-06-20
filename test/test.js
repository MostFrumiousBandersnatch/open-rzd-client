'use strict';

/*global describe, it, before, beforeEach, after, afterEach, module, expect,
    inject */

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
                    mostly_serialized = 'a=1&c=3';;

                expect(encodeDictFactory(source)).toEqual(fully_serialized);
                expect(encodeDictFactory(source, false, true)).toEqual(
                    mostly_serialized
                );
            }
        );
    });
});
