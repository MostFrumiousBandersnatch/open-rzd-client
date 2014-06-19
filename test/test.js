'use strict';

/*global describe, it, before, beforeEach, after, afterEach, module, expect,
    inject */

describe('RZD open API client', function () {
    beforeEach(function () {
        module('rzd');
    });

    describe('encodeDict defined', function () {
        it('should be a working service', inject(['encodeDict',
                function (encodeDict) {
                    expect(encodeDict).toBeDefined();
                }
        ]));
    });
});
