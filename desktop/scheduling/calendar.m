#import <Foundation/Foundation.h>

int main(int argc, const char **argv) { @autoreleasepool {
  if (argc != 2 || strlen(argv[1]) > 512) return 1;
  NSError *error = nil;
  NSDictionary *input = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:argv[1]] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:&error];
  if (error || ![input isKindOfClass:NSDictionary.class] || input.count != 4 || ![input[@"after"] isKindOfClass:NSNumber.class] || ![input[@"timezone"] isKindOfClass:NSString.class] || ![input[@"time"] isKindOfClass:NSString.class] || ![input[@"days"] isKindOfClass:NSArray.class]) return 1;
  double after = [input[@"after"] doubleValue]; NSString *time = input[@"time"]; NSArray *days = input[@"days"];
  NSTimeZone *zone = [NSTimeZone timeZoneWithName:input[@"timezone"]];
  NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^([01][0-9]|2[0-3]):[0-5][0-9]$" options:0 error:nil];
  if (!zone || !isfinite(after) || after < 0 || after > 253401523200000.0 || floor(after) != after || ![pattern numberOfMatchesInString:time options:0 range:NSMakeRange(0,time.length)] || days.count < 1 || days.count > 7) return 1;
  NSMutableSet *unique = [NSMutableSet set];
  for (id day in days) { if (![day isKindOfClass:NSNumber.class] || [day doubleValue] != [day intValue] || [day intValue] < 0 || [day intValue] > 6 || [unique containsObject:day]) return 1; [unique addObject:day]; }
  NSCalendar *calendar = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian]; calendar.timeZone = zone;
  NSDate *instant = [NSDate dateWithTimeIntervalSince1970:after / 1000.0]; NSDate *start = [calendar startOfDayForDate:instant];
  NSDateComponents *matching = [[NSDateComponents alloc] init]; matching.hour = [[time substringToIndex:2] intValue]; matching.minute = [[time substringFromIndex:3] intValue]; matching.second = 0;
  for (NSInteger i = 0; i < 9; i++) {
    NSDate *day = [calendar dateByAddingUnit:NSCalendarUnitDay value:i toDate:start options:0];
    if (![unique containsObject:@([calendar component:NSCalendarUnitWeekday fromDate:day] - 1)]) continue;
    // Search from the day's beginning, so the second instance of a repeated time is never selected.
    NSDate *candidate = [calendar nextDateAfterDate:[day dateByAddingTimeInterval:-1] matchingComponents:matching options:NSCalendarMatchNextTime | NSCalendarMatchFirst];
    if (!candidate || ![calendar isDate:candidate inSameDayAsDate:day] || [calendar component:NSCalendarUnitHour fromDate:candidate] != matching.hour || [calendar component:NSCalendarUnitMinute fromDate:candidate] != matching.minute) {
      // Foundation's next-time matching skips some half-hour gaps. Find the first valid local minute on this day.
      candidate = nil; NSDate *end = [calendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:day options:0];
      for (NSDate *minute = day; [minute compare:end] == NSOrderedAscending; minute = [minute dateByAddingTimeInterval:60]) {
        if ([calendar component:NSCalendarUnitHour fromDate:minute] * 60 + [calendar component:NSCalendarUnitMinute fromDate:minute] >= matching.hour * 60 + matching.minute) { candidate = minute; break; }
      }
    }
    if (candidate && [calendar isDate:candidate inSameDayAsDate:day] && [candidate compare:instant] == NSOrderedDescending) {
      NSData *output = [NSJSONSerialization dataWithJSONObject:@{@"nextAt":@((long long)llround(candidate.timeIntervalSince1970 * 1000.0))} options:0 error:&error];
      if (error) return 1; puts([[NSString alloc] initWithData:output encoding:NSUTF8StringEncoding].UTF8String); return 0;
    }
  }
  return 1;
} }
