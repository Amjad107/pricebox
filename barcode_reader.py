# barcode_reader.py
import sys
from pyzbar.pyzbar import decode
from PIL import Image
import json

def read_barcode(image_path):
    image = Image.open(image_path)
    decoded = decode(image)
    results = []

    for item in decoded:
        results.append({
            'type': item.type,
            'data': item.data.decode('utf-8')
        })

    return results

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("No image path provided.")
        sys.exit(1)

    image_path = sys.argv[1]
    try:
        result = read_barcode(image_path)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
