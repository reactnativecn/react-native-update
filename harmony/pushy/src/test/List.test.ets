import manifestParsingTest from './ManifestParsing.test';
import validationTest from './Validation.test';
import eventHubTest from './EventHub.test';
import downloadTaskParamsTest from './DownloadTaskParams.test';

export default function testsuite() {
  manifestParsingTest();
  validationTest();
  eventHubTest();
  downloadTaskParamsTest();
}
