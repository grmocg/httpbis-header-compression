'use strict';

function Encoder() {
  this.buffer_ = [];
}

Encoder.prototype.encodeOctet = function(o) {
  this.buffer_.push(o & 0xff);
};

// Encodes an integer I into the representation described in 4.1.1. N
// is the number of bits of the prefix as described in 4.1.1, and
// opCode is put into the top (8 - N) bytes of the first octet of the
// encoded integer.
Encoder.prototype.encodeInteger = function(opCode, N, I) {
  var nextMarker = (1 << N) - 1;
  var octets = [];
  var origI = I;

  if (I < nextMarker) {
    octets.push((opCode << N) | I);
    this.encodeOctet((opCode << N) | I);
    //console.log("Encoding: ", origI, " on ", N, " bits with prefixVal: ", opCode, " output: ", octets);
    return;
  }

  if (N > 0) {
    octets.push((opCode << N) | nextMarker);
    this.encodeOctet((opCode << N) | nextMarker);
  }

  I -= nextMarker;
  while (I >= 128) {
    octets.push(I % 128 | 128);
    this.encodeOctet(I % 128 | 128);
    // Divide I by 128. (Remember that / in JavaScript is
    // floating-point division).
    I >>= 7;
  }
  octets.push(I);
  this.encodeOctet(I);
  //console.log("Encoding: ", origI, " on ", N, " bits with prefixVal: ", opCode, " output: ", octets);
}

// Encodes the given octet sequence represented by a string as a
// length-prefixed octet sequence.
Encoder.prototype.encodeOctetSequence = function(str) {
  var str_to_encode = str;
  if (ENCODE_HUFFMAN) {
    var code_table = CLIENT_TO_SERVER_CODEBOOK;
    if (!IS_REQUEST) {
      code_table = SERVER_TO_CLIENT_CODEBOOK;
    }
    str_to_encode = String.fromCharCode.apply(String, encodeBYTES(str, code_table));
  }
  //console.log("str: ", str, " len: ", str_to_encode.length, " is request: ", IS_REQUEST,  " str_to_encode: ", str_to_encode);
  this.encodeInteger(ENCODE_HUFFMAN, 7, str_to_encode.length);
  for (var i = 0; i < str_to_encode.length; ++i) {
    this.encodeOctet(str_to_encode.charCodeAt(i));
  }
}

// All parameters to the encode functions below are assumed to be
// valid.

// Encode an indexed header as described in 4.2.
Encoder.prototype.encodeIndexedHeader = function(index) {
  this.encodeInteger(INDEX_VALUE, INDEX_N, index);
}

// Encode a literal header without indexing as described in 4.3.1.
Encoder.prototype.encodeLiteralHeaderWithoutIndexing = function(
  indexOrName, value) {
  switch (typeof indexOrName) {
    case 'number':
      this.encodeInteger(LITERAL_NO_INDEX_VALUE, LITERAL_NO_INDEX_N,
                         indexOrName + 1);
      this.encodeOctetSequence(value);
      return;

    case 'string':
      this.encodeInteger(LITERAL_NO_INDEX_VALUE, LITERAL_NO_INDEX_N, 0);
      this.encodeOctetSequence(indexOrName);
      this.encodeOctetSequence(value);
      return;
  }

  throw new Error('not an index or name: ' + indexOrName);
}

// Encode a literal header with incremental indexing as described in
// 4.3.2.
Encoder.prototype.encodeLiteralHeaderWithIncrementalIndexing = function(
  indexOrName, value) {
  switch (typeof indexOrName) {
    case 'number':
      this.encodeInteger(LITERAL_INCREMENTAL_VALUE, LITERAL_INCREMENTAL_N,
                         indexOrName + 1);
      this.encodeOctetSequence(value);
      return;

    case 'string':
      this.encodeInteger(LITERAL_INCREMENTAL_VALUE, LITERAL_INCREMENTAL_N,
                         0);
      this.encodeOctetSequence(indexOrName);
      this.encodeOctetSequence(value);
      return;
  }

  throw new Error('not an index or name: ' + indexOrName);
}

Encoder.prototype.flush = function() {
  var buffer = this.buffer_;
  this.buffer_ = [];
  return buffer;
}

// direction can be either REQUEST or RESPONSE, which controls the
// pre-defined header table to use. The higher compressionLevel is,
// the more this encoder tries to exercise the various encoding
// opcodes.
function HeaderEncoder(direction, compressionLevel) {
  this.encodingContext_ = new EncodingContext(direction);
  this.compressionLevel_ = compressionLevel;
}

HeaderEncoder.prototype.setHeaderTableMaxSize = function(maxSize) {
  this.encodingContext_.setHeaderTableMaxSize(maxSize);
};

HeaderEncoder.prototype.encodeHeader_ = function(encoder, name, value) {
  if (!isValidHeaderName(name)) {
    throw new Error('Invalid header name: ' + name);
  }

  if (!isValidHeaderValue(value)) {
    throw new Error('Invalid header value: ' + value);
  }
  // Touches are used below to track how many times a header has been
  // explicitly encoded.

  // Utility function to explicitly emit an entry in the reference
  // set. The entry must already be touched.
  var explicitlyEmitReferenceIndex = function(referenceIndex) {
    if (!this.encodingContext_.isReferenced(referenceIndex)) {
      throw new Error('Trying to explicitly emit entry ' + referenceIndex +
                      ' not in reference set');
    }
    if (this.encodingContext_.getTouchCount(referenceIndex) === null) {
      throw new Error('Trying to explicitly emit untouched entry ' +
                      referenceIndex);
    }
    for (var i = 0; i < 2; ++i) {
      encoder.encodeIndexedHeader(referenceIndex);
      this.encodingContext_.processIndexedHeader(referenceIndex);
    }
    this.encodingContext_.addTouches(referenceIndex, 1);
  }.bind(this);

  if (this.compressionLevel_ > 1) {
    // Check to see if the header is already in the header table, and
    // use the indexed header opcode if so.
    var nameValueIndex =
      this.encodingContext_.findIndexWithNameAndValue(name, value);
    if (nameValueIndex >= 0) {
      if (this.encodingContext_.isReferenced(nameValueIndex)) {
        var emittedCount =
          this.encodingContext_.getTouchCount(nameValueIndex);
        if (emittedCount === null) {
          // Mark that we've encountered this header once but haven't
          // explicitly encoded it (since it's in the reference set).
          this.encodingContext_.addTouches(nameValueIndex, 0);
        } else if (emittedCount == 0) {
          // Explicitly emit the entry twice; once for the previous
          // time this header was encountered (when it wasn't
          // explicitly encoded), and one for this time.
          for (var i = 0; i < 2; ++i) {
            //console.log("explicitlyEmitReferenceIndex: ", nameValueIndex);
            explicitlyEmitReferenceIndex(nameValueIndex);
          }
        } else {
          // We've encoded this header once for each time this was
          // encountered previously, so emit the index just once for
          // this time.
          //console.log("explicitlyEmitReferenceIndex: ", nameValueIndex);
          explicitlyEmitReferenceIndex(nameValueIndex);
        }
      } else {
        // Mark that we've encountered this header once and explicitly
        // encoded it (since it wasn't in the reference set).
        //console.log("encodeIndexedHeader: ", nameValueIndex);
        encoder.encodeIndexedHeader(nameValueIndex);
        this.encodingContext_.processIndexedHeader(nameValueIndex);
        this.encodingContext_.addTouches(nameValueIndex, 1);
      }
      return;
    }
  }

  var index = -1;
  if (this.compressionLevel_ > 0) {
    // Check to see if the header name is already in the header table,
    // and use its index if so.
    index = this.encodingContext_.findIndexWithName(name);
  }

  // Used below when processing literal headers that may evict entries
  // in the reference set.
  var onReferenceSetRemoval = function(referenceIndex) { }.bind(this)
  //   if (this.encodingContext_.getTouchCount(referenceIndex) == 0) {
  //     // The implicitly emitted entry at referenceIndex will be
  //     // removed, so explicitly emit it.
  //     explicitlyEmitReferenceIndex(referenceIndex);
  //   }
  // }.bind(this);

  var indexOrName = (index >= 0) ? index : name;
  if ((this.compressionLevel_ > 3)) {
    // If the header name is not already in the header table, use
    // incremental indexing.
    //console.log("processLiteralHeaderWithIncrementalIndexing: ", name, value);
    var storedIndex =
      this.encodingContext_.processLiteralHeaderWithIncrementalIndexing(
        name, value, onReferenceSetRemoval);
    encoder.encodeLiteralHeaderWithIncrementalIndexing(indexOrName, value);
    if (storedIndex >= 0) {
      this.encodingContext_.addTouches(storedIndex, 1);
    }
    return;
  }

  // Don't index at all.
  //console.log("encodeLiteralHeaderWithoutIndexing: ", indexOrName, value);
  encoder.encodeLiteralHeaderWithoutIndexing(indexOrName, value);
};

// The given header set is encoded as an array of octets which is then
// returned. An exception will be thrown if an error is encountered.
HeaderEncoder.prototype.encodeHeaderSet = function(headerSet) {
  var encoder = new Encoder();
  for (var i = 0; i < headerSet.length; ++i) {
    var key = headerSet[i][0];
    var value = headerSet[i][1];
    var values = [value];
    if (key == "cookie") {
      // TODO: Enable this functionality with a button.
      //values = value.split('; ');
    }
    for (var j = 0; j < values.length; ++j) {
      this.encodeHeader_(encoder, key, values[j]);
    }
  }

  // Remove each header not in the just-encoded header set from the
  // reference set.
  this.encodingContext_.forEachEntry(
    function(index, name, value, referenced, touchCount) {
      if (referenced && (touchCount === null)) {
        encoder.encodeIndexedHeader(index);
        this.encodingContext_.processIndexedHeader(index);
      }
      this.encodingContext_.clearTouches(index);
    }.bind(this));

  return encoder.flush();
}
