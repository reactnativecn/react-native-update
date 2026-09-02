import manifestParsingTest from './ManifestParsing.test';
import validationTest from './Validation.test';
import eventHubTest from './EventHub.test';
import downloadTaskParamsTest from './DownloadTaskParams.test';
import contentRangeTest from './ContentRange.test';
import installRecordTest from './InstallRecord.test';
import errorCodesTest from './ErrorCodes.test';

export default function testsuite() {
  manifestParsingTest();
  validationTest();
  eventHubTest();
  downloadTaskParamsTest();
  contentRangeTest();
  installRecordTest();
  errorCodesTest();
}
