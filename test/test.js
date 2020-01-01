"use strict";

/*global jasmine, describe, it, beforeEach, afterEach, module,
    expect, inject, spyOn
*/

describe("RZD open API client", function() {
  beforeEach(function() {
    module("rzd");
  });

  describe("encodeDict", function() {
    var encodeDictFactory;

    beforeEach(inject(function(encodeDict) {
      encodeDictFactory = encodeDict;
    }));

    it("should exists", function() {
      expect(encodeDictFactory).toBeDefined();
    });

    it("should performs serialization", function() {
      var source = {
          a: 1,
          b: "M&Ms"
        },
        serialized = "a=1&b=M%26Ms";

      expect(encodeDictFactory(source)).toEqual(serialized);
    });

    it("should performs serialization without encoding as well", function() {
      var source = {
          a: "привет",
          b: "пока"
        },
        serialized = "a=привет&b=пока";

      expect(encodeDictFactory(source, true)).toEqual(serialized);
    });

    it("should skip empty items in case", function() {
      var source = {
          a: 1,
          b: "",
          c: 3
        },
        fully_serialized = "a=1&b=&c=3",
        mostly_serialized = "a=1&c=3";

      expect(encodeDictFactory(source)).toEqual(fully_serialized);
      expect(encodeDictFactory(source, false, true)).toEqual(mostly_serialized);
    });
  });

  describe("StorageLookup", function() {
    var $httpBackend, StorageLookup, GlobalConfig;

    function testTrainListForDecember31th(pseudo_now, expected_trains_count) {
      return inject(function($templateCache, $filter, RZD_TIME_FORMAT) {
        var response;

        $httpBackend
          .expectGET(
            "http://" +
              GlobalConfig.api_host + "/" +
              GlobalConfig.api_prefix +
              "/combine/list?date=31.12.2019&from=2000000&to=2060150"
          )
          .respond(
            JSON.parse($templateCache.get("moscow_to_izh_31.12_stored.json"))
          );

        spyOn(Date, "now").andReturn(pseudo_now);

        response = StorageLookup.fetchList({
          from: 2000000,
          to: 2060150,
          date: "31.12.2019"
        });

        $httpBackend.flush();

        expect(angular.isArray(response)).toBeTruthy();
        expect(response.length).toEqual(expected_trains_count);
        angular.forEach(response, function(train_row) {
          expect(train_row.time0).toBeGreaterThan(
            $filter("date")(pseudo_now, RZD_TIME_FORMAT)
          );
        });
      });
    }

    beforeEach(function() {
      module("rzd_client_config");
      module("fixtures");

      inject(function($injector) {
        $httpBackend = $injector.get("$httpBackend");
        StorageLookup = $injector.get("StorageLookup");
        GlobalConfig = $injector.get("GLOBAL_CONFIG");
      });
    });

    it("should call the right URL and return an array", function() {
      var response;

      $httpBackend
        .expectGET(
          "http://" +
            GlobalConfig.api_host + "/" +
            GlobalConfig.api_prefix +
            "/combine/list?date=01.01.2015&from=2000000&to=2004000"
        )
        .respond({ rows: [] });

      response = StorageLookup.fetchList({
        from: 2000000,
        to: 2004000,
        date: "01.01.2015"
      });

      $httpBackend.flush();

      expect(angular.isArray(response)).toBeTruthy();
      expect(response.length).toEqual(0);
    });

    it(
      "should return full list of trains for this very day",
      testTrainListForDecember31th(new Date(2019, 11, 31, 0, 10, 0), 3)
    );

    it(
      "should not return train already departured at 17:38",
      testTrainListForDecember31th(new Date(2019, 11, 31, 17, 0, 0), 1)
    );

    it(
      "should return empty list in a back-to-the-future case",
      testTrainListForDecember31th(new Date(2020, 0, 1, 22, 0, 0), 0)
    );

    it(
      "should return empty list in a back-to-the-future case",
      testTrainListForDecember31th(new Date(2019, 11, 31, 17, 41, 0), 0)
    );

    it(
      "should return full list of trains for the passed day",
      testTrainListForDecember31th(new Date(2019, 11, 30, 0, 0, 1), 3)
    );
  });

  describe("Watcher", function() {
    var Watcher,
      cars_found_sample = {
        freeSeats: 170,
        itype: 4,
        pt: 911,
        servCls: "2\u0422",
        tariff: 3045,
        type: "\u041a\u0443\u043f\u0435",
        typeLoc: "\u041a\u0443\u043f\u0435"
      };

    beforeEach(inject(function($injector) {
      Watcher = $injector.get("Watcher");
    }));

    it("should make watcher keys properly", function() {
      var w = new Watcher("258А", "13:45", "Купе");

      expect(w.key).toEqual("train_num=258А&dep_time=13:45&seat_type=Купе");
    });

    it("watcher`s lifecycle", function() {
      // initial WAITING
      var w = new Watcher("258А", "13:45", "Купе"),
        check_waiting_watcher = function(w) {
          expect(w.isWaiting()).toBeTruthy();
          expect(w.isSucceeded()).toBeFalsy();
          expect(w.isAccepted()).toBeFalsy();
          expect(w.cars_found).toEqual(null);

          expect(w.claimFailed()).toBeFalsy();
          expect(w.accept()).toBeFalsy();
        },
        check_succeeded_watcher = function(w) {
          expect(w.isWaiting()).toBeFalsy();
          expect(w.isSucceeded()).toBeTruthy();
          expect(w.isAccepted()).toBeFalsy();
          expect(w.cars_found).toEqual(cars_found_sample);

          expect(w.claimSucceeded(cars_found_sample)).toBeFalsy();
        };

      check_waiting_watcher(w);

      // WAITING --> SUCCEEDED
      expect(w.claimSucceeded(cars_found_sample)).toBeTruthy();
      check_succeeded_watcher(w);

      // SUCCEEDED --> WAITING
      expect(w.claimFailed()).toBeTruthy();
      check_waiting_watcher(w);

      // WAITING --> SUCCEEDED again
      w.claimSucceeded(cars_found_sample);
      check_succeeded_watcher(w);

      // SUCCEEDED --> ACCEPTED
      expect(w.accept()).toBeTruthy();

      expect(w.isWaiting()).toBeFalsy();
      expect(w.isSucceeded()).toBeFalsy();
      expect(w.isAccepted()).toBeTruthy();

      // ACCEPTED --> WAITING
      expect(w.claimFailed()).toBeFalsy();
      expect(w.claimSucceeded(cars_found_sample)).toBeFalsy();
      expect(w.restart()).toBeTruthy();
      check_waiting_watcher(w);
    });
  });

  describe("TrackingTask", function() {
    var TaskInt;

    beforeEach(inject(function(TrackingTask) {
      TaskInt = TrackingTask;
    }));

    it("should make task keys properly", function() {
      expect(
        TaskInt.makeKey("list", [20000000, 20004000, "01.01.2015"])
      ).toEqual("list,20000000,20004000,01.01.2015");

      expect(
        TaskInt.makeKey("details", [
          20000000,
          20004000,
          "01.01.2015",
          "054Ч",
          "23:40"
        ])
      ).toEqual("details,20000000,20004000,01.01.2015,054Ч,23:40");
    });
  });
});
